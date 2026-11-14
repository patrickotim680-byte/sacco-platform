import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { toCsv } from "@/lib/csv";
import { fmtCell, type Report } from "@/lib/services/reports";

export function reportCsv(r: Report) {
  const rows: unknown[][] = [[r.title], [r.subtitle], []];
  for (const s of r.sections) {
    rows.push([s.title], s.columns.map((c) => c.label));
    for (const row of s.rows) rows.push(s.columns.map((c) => (c.type === "money" || c.type === "number" ? (row[c.key] === null || row[c.key] === undefined ? "" : Number(row[c.key])) : fmtCell(row[c.key], c.type))));
    if (s.footer) rows.push(s.columns.map((c) => (s.footer![c.key] === undefined ? "" : c.type === "money" ? Number(s.footer![c.key]) : String(s.footer![c.key]))));
    rows.push([]);
  }
  return toCsv(rows);
}

export async function reportXlsx(r: Report, orgName: string) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "SokoSave";
  r.sections.forEach((s, i) => {
    const ws = wb.addWorksheet(`${i + 1}. ${s.title}`.replace(/[\\/?*[\]:]/g, " ").slice(0, 31));
    ws.addRow([orgName]).font = { bold: true, size: 13 };
    ws.addRow([`${r.title} - ${r.subtitle}`]);
    ws.addRow([]);
    const head = ws.addRow(s.columns.map((c) => c.label));
    head.font = { bold: true };
    head.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF2" } }; });
    for (const row of s.rows) ws.addRow(s.columns.map((c) => (c.type === "money" || c.type === "number" ? (row[c.key] === null || row[c.key] === undefined ? null : Number(row[c.key])) : fmtCell(row[c.key], c.type))));
    if (s.footer) { const f = ws.addRow(s.columns.map((c) => (s.footer![c.key] === undefined ? "" : c.type === "money" ? Number(s.footer![c.key]) : String(s.footer![c.key])))); f.font = { bold: true }; }
    s.columns.forEach((c, k) => { const col = ws.getColumn(k + 1); col.width = Math.min(48, Math.max(12, c.label.length + 4)); if (c.type === "money") col.numFmt = "#,##0"; });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function reportPdf(r: Report, orgName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const W = doc.page.width - 72;
    doc.font("Helvetica-Bold").fontSize(15).text(orgName);
    doc.font("Helvetica-Bold").fontSize(12).text(r.title);
    doc.font("Helvetica").fontSize(9).fillColor("#555").text(`${r.subtitle}  |  Generated ${new Date().toLocaleString("en-GB", { timeZone: "Africa/Kampala" })} EAT  |  Currency: UGX`).fillColor("#000");
    doc.moveDown(0.8);
    for (const s of r.sections) {
      if (doc.y > doc.page.height - 120) doc.addPage();
      doc.font("Helvetica-Bold").fontSize(10.5).text(s.title);
      doc.moveDown(0.3);
      const weights = s.columns.map((c) => (c.type === "money" || c.type === "number" ? 1 : c.type === "date" ? 1 : c.key.match(/description|detail|minutes|agenda|name/) ? 2.6 : 1.5));
      const tw = weights.reduce((a, b) => a + b, 0);
      const widths = weights.map((w) => (w / tw) * W);
      const drawRow = (cells: string[], bold: boolean, shade: boolean) => {
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8);
        const h = Math.max(...cells.map((t, i) => doc.heightOfString(t, { width: widths[i] - 6 })), 10) + 6;
        if (doc.y + h > doc.page.height - 50) { doc.addPage(); }
        const y = doc.y;
        if (shade) doc.rect(36, y, W, h).fill("#eef1f4").fillColor("#000");
        let x = 36;
        cells.forEach((t, i) => {
          const right = s.columns[i].type === "money" || s.columns[i].type === "number";
          doc.text(t, x + 3, y + 3, { width: widths[i] - 6, align: right ? "right" : "left" });
          x += widths[i];
        });
        doc.moveTo(36, y + h).lineTo(36 + W, y + h).strokeColor("#d5d9de").lineWidth(0.5).stroke().strokeColor("#000");
        doc.y = y + h;
      };
      drawRow(s.columns.map((c) => c.label), true, true);
      if (s.rows.length === 0) drawRow(["No records"].concat(s.columns.slice(1).map(() => "")), false, false);
      for (const row of s.rows) drawRow(s.columns.map((c) => fmtCell(row[c.key], c.type)), false, false);
      if (s.footer) drawRow(s.columns.map((c) => (s.footer![c.key] === undefined ? "" : c.type === "money" ? fmtCell(s.footer![c.key], "money") : String(s.footer![c.key]))), true, true);
      doc.moveDown(1);
    }
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.font("Helvetica").fontSize(7.5).fillColor("#777").text(`SokoSave - ${orgName} - Page ${i + 1} of ${range.count}`, 36, doc.page.height - 28, { width: W, align: "center", lineBreak: false });
    }
    doc.end();
  });
}
