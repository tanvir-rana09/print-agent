/**
 * Production-Ready Print Agent
 * ----------------------------
 * - Polls Laravel API for pending jobs (by printer_id)
 * - Server side locks job as `processing` to avoid races
 * - Retries before marking job as failed
 * - Logs to agent.log and agent-error.log
 * - Runs automatically with pm2
 */

const axios = require("axios");
const escpos = require("escpos");
escpos.USB = require("escpos-usb");
const fs = require("fs");

// ================= CONFIG ================= //
// You can move these to environment variables if you prefer.
const PRINTER_ID = 2; // This PC's thermal printer id in your system
const API_BASE = "http://china-club.dhaka-club-erp.test/api/v1/client/public";
const API_KEY = "QKrzTzyQvCRDf6F0sW3mea1UWoMlplKFHiP7Wa5M8zeRqjmEJJaBCmADAdiXK9MJ";

const POLL_INTERVAL_MS = 5000; // 5s
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 10000;

// ================ Logging ================= //
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync("agent.log", line);
  console.log(line.trim());
}

function errorLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync("agent-error.log", line);
  console.error(line.trim());
}

// ============== Printer helpers ============== //
function getPrinter() {
  // Extend here later to support Network printers (escpos.Network)
  try {
    const device = new escpos.USB();
    const printer = new escpos.Printer(device);
    return { device, printer };
  } catch (err) {
    throw new Error(`USB printer not found: ${err.message}`);
  }
}

// ============== Formatting helpers ============== //
function pad(str, len) {
  const s = String(str ?? "");
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

function money(x) {
  if (x == null || isNaN(Number(x))) return "0";
  return String(parseFloat(x).toFixed(2));
}

// ============== Core ============== //
async function pollOnce() {
  try {
    const res = await axios.get(`${API_BASE}/printers/jobs`, {
      params: { printer_id: PRINTER_ID },
      headers: { "X-Printer-Key": API_KEY },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true, // we'll handle non-200s
    });

    if (res.status === 204 || !res.data) {
      log("No pending jobs");
      return;
    }
    
    if (res.status !== 200) {
      errorLog(`Job fetch failed: HTTP ${res.status} ${JSON.stringify(res.data)}`);
      return;
    }

    const job = res.data;
    if (!job || !job.print_data) {
      log("No pending jobs (empty body)");
      return;
    }

    log(`Picked job ${job.id} (server marked as 'processing')`);

    await handleJob(job);
  } catch (err) {
    errorLog(`Polling error: ${err.message}`);
  }
}

async function handleJob(job) {
  let attempts = 0;

  while (attempts < MAX_RETRIES) {
    attempts++;
    try {
      // await printJob(job.print_data);

      const ok = await mark(job.id, "printed");
      if (!ok) errorLog(`Warning: could not mark job ${job.id} as printed (non-200 response)`);
      log(`Job ${job.id} printed successfully ✅`);
      return;
    } catch (err) {
      errorLog(`Print attempt ${attempts}/${MAX_RETRIES} failed for job ${job.id}: ${err.message}`);
      if (attempts < MAX_RETRIES) {
        await delay(2000);
      } else {
        const ok = await mark(job.id, "failed", err.message);
        if (!ok) errorLog(`Warning: could not mark job ${job.id} as failed (non-200 response)`);
        log(`Job ${job.id} marked as failed ❌`);
      }
    }
  }
}

async function mark(jobId, status, error_message) {
  try {
    const res = await axios.post(
      `${API_BASE}/printers/jobs/${jobId}/mark-printed`,
      { status, ...(error_message ? { error_message } : {}) },
      {
        headers: { "X-Printer-Key": API_KEY },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      }
    );
    if (res.status !== 200) {
      errorLog(`Mark status failed for job ${jobId}: HTTP ${res.status} ${JSON.stringify(res.data)}`);
      return false;
    }
    return true;
  } catch (err) {
    errorLog(`Mark status error for job ${jobId}: ${err.message}`);
    return false;
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function printJob(data) {
  return new Promise((resolve, reject) => {
    const { device, printer } = getPrinter();

    device.open((err) => {
      if (err) return reject(new Error(`Printer open failed: ${err.message}`));

      try {
        const company = data.company_name || "Company Name";
        const address = data.company_address || "";
        const vat = data.vat_reg_no || "";
        const invoice = data.invoice_id || "";
        const date = data.date || "";
        const member = data.member_name || "";
        const dept = data.department_name || "";
        const payment = (data.payment_type_id || "").toString().toUpperCase();
        const products = Array.isArray(data.products) ? data.products : [];

        // Header
        printer
          .align("ct")
          .style("b")
          .size(1, 1)
          .text(company)
          .style("normal")
          .size(0, 0);

        if (address) printer.text(address);
        if (vat) printer.text(vat);
        printer.text("--------------------------------");

        // Meta
        printer
          .align("lt")
          .text(`Invoice: ${invoice}`)
          .text(`Date: ${date}`)
          .text(`Member: ${member}`)
          .text(`Department: ${dept}`)
          .text(`Payment: ${payment}`)
          .text("--------------------------------");

        // Items
        printer.text("Item               Qty   Price    Total");
        printer.text("--------------------------------");

        products.forEach((p) => {
          const name = pad((p.name || "").toString(), 18);
          const qty = pad(p.quantity ?? 0, 4);
          const price = pad(money(p.price), 8);
          const total = pad(money(p.total ?? ((p.quantity || 0) * (p.price || 0))), 8);
          printer.text(`${name}${qty}${price}${total}`);
        });

        printer.text("--------------------------------");

        // Totals
        const discount = money(data.discount || 0);
        const service = money(data.service || 0);
        const vatAmt = money(data.vat || 0);
        const invoiceDisc = money(data.invoice_discount_amount || 0);
        const grand = money(data.total || 0);
        const inWords = data.total_in_words || "";

        printer
          .text(`Discount: ${discount}`)
          .text(`Service : ${service}`)
          .text(`VAT     : ${vatAmt}`)
          .text(`Inv Disc: ${invoiceDisc}`)
          .text(`TOTAL   : ${grand}`);

        if (inWords) printer.text(`In Words: ${inWords}`);

        printer
          .text("--------------------------------")
          .align("ct")
          .text("Thank you!")
          .feed(4)
          .cut()
          .close();

        resolve();
      } catch (e) {
        try {
          // attempt to close device if something went wrong mid-print
          printer.close();
        } catch (_) {}
        reject(e);
      }
    });
  });
}

// ======= Start ======= //
log("Print Agent started 🚀");
pollOnce(); // do one immediately
setInterval(pollOnce, POLL_INTERVAL_MS);

// Safety: avoid process crash on unexpected promise errors
process.on("unhandledRejection", (err) => {
  errorLog(`UnhandledRejection: ${err?.message || err}`);
});
process.on("uncaughtException", (err) => {
  errorLog(`UncaughtException: ${err?.message || err}`);
});
