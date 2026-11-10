/**
 * Capture linha digitável from pagfacil "Pagar boleto".
 *
 * Fast path: Imprimir Boleto → network/PDF → extract linha (~10–15s).
 * If data-codigo empty AND Imprimir yields no download → boleto_pending (portal-side).
 * Copiar is a short fallback only when print fails but DOM may have codigo.
 * Never treat empty linha as success.
 */
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractText } from "unpdf";

export function extractLinha(text) {
  if (!text) return null;
  const compact = String(text).replace(/\D/g, "");
  if (compact.length >= 47) return compact.slice(0, 47);
  const m47 = String(text).replace(/\s/g, "").match(/(?:\D|^)(\d{47})(?:\D|$)/);
  if (m47) return m47[1];
  const mDig = compact.match(/\d{47}/);
  return mDig ? mDig[0] : null;
}

export function parseMoney(text) {
  const m = String(text || "").match(/R\$\s*([\d.]+,\d{2})/);
  if (!m) return null;
  return Number(m[1].replace(/\./g, "").replace(",", ".")).toFixed(2);
}

export async function readPagfacilFields(page) {
  return page.evaluate(() => {
    const urlBoleto = document.querySelector("#urlBoleto")?.value || "";
    const dataCodigo =
      document.querySelector("#linkCodigoBarras a")?.dataset?.codigo ||
      document.querySelector("a[data-codigo]")?.getAttribute("data-codigo") ||
      "";
    const pText = document.querySelector("#codigoBarras p")?.innerText || "";
    const pedido = document.querySelector("#pedido")?.value || "";
    const pagamentoId = document.querySelector("#pagamentoId")?.value || "";
    return { urlBoleto, dataCodigo, pText, pedido, pagamentoId, href: location.href };
  });
}

async function patchClipboard(page) {
  await page.evaluate(() => {
    window.__copiedBarcode = null;
    try {
      const proto = navigator.clipboard;
      if (proto && !proto.__patchedForRpa) {
        const origWrite = proto.writeText.bind(proto);
        proto.writeText = async (text) => {
          window.__copiedBarcode = text;
          try {
            return await origWrite(text);
          } catch {
            return undefined;
          }
        };
        proto.__patchedForRpa = true;
      }
    } catch {
      /* ignore */
    }
  });
}

async function linhaFromPdfBuffer(buf) {
  if (!buf || buf.length < 50) return null;
  let linha = extractLinha(buf.toString("latin1"));
  if (linha && linha.length >= 47) return { linha, via: "latin1" };
  try {
    const { text } = await extractText(new Uint8Array(buf));
    const joined = Array.isArray(text) ? text.join("\n") : String(text || "");
    linha = extractLinha(joined);
    if (linha) return { linha, via: "unpdf", textSnippet: joined.slice(0, 500) };
  } catch (e) {
    console.log("unpdf_extract_fail", String(e.message || e).slice(0, 120));
  }
  return linha ? { linha, via: "latin1-short" } : null;
}

/**
 * Imprimir Boleto with network capture for the real PDF URL (when portal issued it).
 * Budget: ~10–15s total — no long spin.
 */
async function captureViaImprimir(boletoPage, context, opts) {
  const { mediaDir, shotPrefix, timeoutMs = 15000 } = opts;
  let fields = await readPagfacilFields(boletoPage);
  const networkHits = [];

  const onResponse = async (resp) => {
    try {
      const u = resp.url();
      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      const interesting =
        /pdf|boleto|arquivo|imprimir|download/i.test(u) ||
        ct.includes("pdf") ||
        ct.includes("octet-stream");
      if (!interesting) return;
      const entry = { url: u, status: resp.status(), ct, len: null, isPdf: false };
      try {
        const body = Buffer.from(await resp.body());
        entry.len = body.length;
        entry.isPdf = body.slice(0, 4).toString() === "%PDF";
        if (entry.isPdf) entry._buf = body;
      } catch {
        /* body may be unavailable */
      }
      networkHits.push(entry);
      console.log("imprimir_net", {
        status: entry.status,
        ct: entry.ct,
        len: entry.len,
        isPdf: entry.isPdf,
        url: u.slice(0, 160),
      });
    } catch {
      /* ignore */
    }
  };
  boletoPage.on("response", onResponse);
  context.on("response", onResponse);

  try {
    // 1) Hidden urlBoleto already filled?
    if (fields.urlBoleto) {
      try {
        const resp = await context.request.get(fields.urlBoleto, { timeout: timeoutMs });
        const body = Buffer.from(await resp.body());
        if (resp.ok() && body.slice(0, 4).toString() === "%PDF") {
          console.log("pdf via urlBoleto bytes=", body.length);
          return {
            pdfBuf: body,
            pdfUrl: fields.urlBoleto,
            fields,
            via: "urlBoleto",
            networkHits,
          };
        }
      } catch (e) {
        console.log("urlBoleto_fetch_fail", String(e.message || e).slice(0, 80));
      }
    }

    const downloadPromise = boletoPage.waitForEvent("download", { timeout: timeoutMs }).catch(() => null);
    const popupPromise = context.waitForEvent("page", { timeout: timeoutMs }).catch(() => null);

    const imprimir = boletoPage.locator("#btn-imprimir-boleto, button:has-text('Imprimir Boleto')").first();
    if (await imprimir.count()) {
      console.log("clicked Imprimir Boleto");
      await imprimir.click({ force: true });
    } else {
      console.log("Imprimir Boleto button missing");
    }

    const [download, popup] = await Promise.all([downloadPromise, popupPromise]);
    await boletoPage.waitForTimeout(800);
    await boletoPage.screenshot({ path: join(mediaDir, `${shotPrefix}-03-after-imprimir.png`), fullPage: true }).catch(() => {});

    fields = await readPagfacilFields(boletoPage);

    // Network PDF captured during click
    const netPdf = networkHits.find((h) => h.isPdf && h._buf);
    if (netPdf) {
      return {
        pdfBuf: netPdf._buf,
        pdfUrl: netPdf.url,
        fields,
        via: "network",
        networkHits: networkHits.map(({ url, status, ct, len, isPdf }) => ({ url, status, ct, len, isPdf })),
      };
    }

    if (download) {
      const path = join(mediaDir, `${shotPrefix}-boleto-download.pdf`);
      await download.saveAs(path).catch(() => {});
      try {
        const body = readFileSync(path);
        if (body.slice(0, 4).toString() === "%PDF") {
          console.log("pdf via download", body.length);
          return {
            pdfBuf: body,
            pdfUrl: download.url(),
            fields,
            via: "download",
            networkHits: networkHits.map(({ url, status, ct, len, isPdf }) => ({ url, status, ct, len, isPdf })),
          };
        }
      } catch {
        /* ignore */
      }
    }

    if (popup) {
      await popup.waitForLoadState("domcontentloaded").catch(() => {});
      for (let i = 0; i < 10 && /^about:blank/i.test(popup.url()); i++) await popup.waitForTimeout(300);
      console.log("print_popup_url", popup.url());
      const popUrl = popup.url();
      if (popUrl && !/^about:blank/i.test(popUrl)) {
        try {
          const resp = await context.request.get(popUrl, { timeout: 15000 });
          const body = Buffer.from(await resp.body());
          if (body.slice(0, 4).toString() === "%PDF") {
            await popup.close().catch(() => {});
            return {
              pdfBuf: body,
              pdfUrl: popUrl,
              fields,
              via: "popup",
              networkHits: networkHits.map(({ url, status, ct, len, isPdf }) => ({ url, status, ct, len, isPdf })),
            };
          }
          const htmlText = await popup.locator("body").innerText().catch(() => "");
          const fromHtml = extractLinha(htmlText);
          await popup.close().catch(() => {});
          if (fromHtml && fromHtml.length >= 47) {
            return {
              pdfBuf: null,
              pdfUrl: popUrl,
              fields,
              via: "popup-html",
              linhaDirect: fromHtml,
              networkHits: networkHits.map(({ url, status, ct, len, isPdf }) => ({ url, status, ct, len, isPdf })),
            };
          }
        } catch (e) {
          console.log("popup_fetch_fail", String(e.message || e).slice(0, 80));
          await popup.close().catch(() => {});
        }
      } else {
        await popup.close().catch(() => {});
      }
    }

    if (fields.urlBoleto) {
      try {
        const resp = await context.request.get(fields.urlBoleto, { timeout: 15000 });
        const body = Buffer.from(await resp.body());
        if (resp.ok() && body.slice(0, 4).toString() === "%PDF") {
          return {
            pdfBuf: body,
            pdfUrl: fields.urlBoleto,
            fields,
            via: "urlBoleto-postclick",
            networkHits: networkHits.map(({ url, status, ct, len, isPdf }) => ({ url, status, ct, len, isPdf })),
          };
        }
      } catch {
        /* ignore */
      }
    }

    return {
      pdfBuf: null,
      pdfUrl: fields.urlBoleto || null,
      fields,
      via: "none",
      networkHits: networkHits.map(({ url, status, ct, len, isPdf }) => ({ url, status, ct, len, isPdf })),
    };
  } finally {
    boletoPage.off("response", onResponse);
    context.off("response", onResponse);
  }
}

/** One quick Copiar attempt (not a long poll). */
async function quickCopiarOnce(boletoPage, context) {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(boletoPage.url()).origin,
  }).catch(() => {});
  await patchClipboard(boletoPage);
  const fields = await readPagfacilFields(boletoPage);
  const immediate = extractLinha(fields.dataCodigo) || extractLinha(fields.pText);
  if (immediate) return { linha: immediate, via: "dom" };

  await boletoPage.locator("#linkCodigoBarras a").click({ force: true }).catch(() => {});
  await boletoPage.waitForTimeout(600);
  const intercepted = await boletoPage.evaluate(() => window.__copiedBarcode || null).catch(() => null);
  const clip = await boletoPage.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  }).catch(() => "");
  const linha = extractLinha(intercepted) || extractLinha(clip);
  console.log("copiar_once", { linha: linha ? `len=${linha.length}` : null });
  return { linha, via: linha ? "clipboard" : "empty" };
}

/**
 * @param {import('playwright').Page} boletoPage
 * @param {import('playwright').BrowserContext} context
 * @param {{ tracking: string, boletosDir: string, mediaDir: string, shotPrefix?: string, printTimeoutMs?: number }} opts
 * @returns {Promise<object>} includes paymentStatusHint: 'boleto_generated' | 'boleto_pending'
 */
export async function capturePagfacilBoleto(boletoPage, context, opts) {
  const {
    tracking,
    boletosDir,
    mediaDir,
    shotPrefix = "pagfacil",
    printTimeoutMs = 15000,
  } = opts;
  mkdirSync(boletosDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });

  await boletoPage.waitForLoadState("domcontentloaded").catch(() => {});
  await boletoPage.waitForTimeout(500);
  await boletoPage.screenshot({ path: join(mediaDir, `${shotPrefix}-01-resumo.png`), fullPage: true }).catch(() => {});

  await boletoPage.getByText(/Copiar c[oó]digo de barras|Pagar boleto|Imprimir Boleto/i).first()
    .waitFor({ timeout: 15000 })
    .catch(() => {});

  let linha = null;
  let pdfBuf = null;
  let pdfPath = null;
  let pdfSha = null;
  let captureVia = null;
  let networkHits = [];
  let fields = await readPagfacilFields(boletoPage);
  const dataLen = fields.dataCodigo ? fields.dataCodigo.replace(/\D/g, "").length : 0;
  console.log("pagfacil_fields", {
    dataCodigoLen: dataLen,
    pTextLen: fields.pText ? fields.pText.replace(/\D/g, "").length : 0,
    urlBoleto: fields.urlBoleto ? fields.urlBoleto.slice(0, 100) : null,
    pedido: fields.pedido || null,
    pagamentoId: fields.pagamentoId || null,
  });

  linha = extractLinha(fields.dataCodigo) || extractLinha(fields.pText);
  if (linha) captureVia = "dom-initial";

  // Fast path: Imprimir (~10–15s) with network capture
  let printed = null;
  if (!linha) {
    printed = await captureViaImprimir(boletoPage, context, {
      mediaDir,
      shotPrefix,
      timeoutMs: printTimeoutMs,
    });
    fields = printed.fields || fields;
    networkHits = printed.networkHits || [];
    captureVia = printed.via;
    if (printed.linhaDirect) {
      linha = printed.linhaDirect;
      captureVia = printed.via;
    }
    if (printed.pdfBuf) {
      pdfBuf = printed.pdfBuf;
      const extracted = await linhaFromPdfBuffer(pdfBuf);
      if (extracted?.linha) {
        linha = extracted.linha;
        captureVia = `${printed.via}+${extracted.via}`;
        console.log("linha_from_pdf", { via: captureVia, len: linha.length });
      } else {
        console.log("pdf_obtained_but_no_linha", { via: printed.via, bytes: pdfBuf.length });
      }
    } else {
      console.log("imprimir_no_pdf", { via: printed.via, urlBoleto: printed.pdfUrl });
    }
  }

  // One quick Copiar only if DOM might have codigo (not a multi-minute poll)
  if (!linha) {
    fields = await readPagfacilFields(boletoPage);
    const dLen = fields.dataCodigo ? fields.dataCodigo.replace(/\D/g, "").length : 0;
    if (dLen > 0 || (fields.pText || "").replace(/\D/g, "").length > 0) {
      const fb = await quickCopiarOnce(boletoPage, context);
      if (fb.linha) {
        linha = fb.linha;
        captureVia = `copiar:${fb.via}`;
      }
    }
  }

  // Fast-fail: empty data-codigo + no PDF download → portal boleto not issued
  fields = await readPagfacilFields(boletoPage);
  const finalDataLen = fields.dataCodigo ? fields.dataCodigo.replace(/\D/g, "").length : 0;
  const portalNotIssued = !linha && finalDataLen === 0 && !pdfBuf && !(fields.urlBoleto);
  if (portalNotIssued) {
    captureVia = captureVia || "none";
    console.log("FAST_FAIL boleto_pending", {
      reason: "empty data-codigo + Imprimir no download (portal did not issue boleto)",
      pagamentoId: fields.pagamentoId,
      pedido: fields.pedido,
      networkHits: networkHits.length,
    });
  }

  const bodyText = await boletoPage.locator("body").innerText().catch(() => "");
  const amount = parseMoney(bodyText);
  const portal =
    fields?.pedido ||
    (bodyText.match(/Resumo do Pedido\s*([0-9]+)/i) || [])[1] ||
    null;
  const dueMatch = bodyText.match(/Vencimento\s*(\d{2}\/\d{2}\/\d{4})/i);
  let dueDate = null;
  if (dueMatch) {
    const [d, m, y] = dueMatch[1].split("/");
    dueDate = `${y}-${m}-${d}`;
  }

  if (pdfBuf && pdfBuf.length > 100) {
    pdfPath = `storage/boletos/${tracking}.pdf`;
    writeFileSync(join(boletosDir, `${tracking}.pdf`), pdfBuf);
    pdfSha = createHash("sha256").update(pdfBuf).digest("hex");
  }

  const paymentStatusHint = linha ? "boleto_generated" : portalNotIssued ? "boleto_pending" : "boleto_pending";

  return {
    linha,
    amount,
    portalOrderId: portal,
    dueDate,
    pdfPath,
    pdfSha,
    pagamentoId: fields?.pagamentoId || null,
    urlBoleto: fields?.urlBoleto || null,
    finalUrl: boletoPage.url(),
    bodySnippet: bodyText.slice(0, 1500),
    barcodeTimedOut: !linha,
    barcodeAttempts: 0,
    captureVia,
    paymentStatusHint,
    portalNotIssued,
    networkHits,
    linhaSources: { captureVia, linha: linha ? `len=${linha.length}` : null },
  };
}
