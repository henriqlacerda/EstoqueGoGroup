import type { CsvRow, Dataset, Purchase, Sale, Sku, StockRecord } from "./types";

export interface CsvUploadTexts {
  skus: string;
  sales: string;
  stock: string;
  purchases: string;
}

export function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift()?.map((value, index) => index === 0 ? value.replace(/^\uFEFF/, "") : value) ?? [];
  return rows.filter((values) => values.some((value) => value !== "")).map((values) =>
    Object.fromEntries(header.map((key, index) => [key, values[index] ?? ""])),
  );
}

const number = (value: string) => value.trim() === "" ? 0 : Number(value);

function requireColumns(rows: CsvRow[], filename: string, required: string[]) {
  const missing = required.filter((column) => rows.length === 0 || !(column in rows[0]));
  if (missing.length) throw new Error(`${filename}: colunas ausentes (${missing.join(", ")}).`);
}

export function parseUploadedData(files: CsvUploadTexts): Dataset {
  const skuRows = parseCsv(files.skus);
  const rawSales = parseCsv(files.sales);
  const stockRows = parseCsv(files.stock);
  const purchaseRows = parseCsv(files.purchases);
  requireColumns(skuRows, "skus.csv", ["sku", "marca", "descricao", "categoria", "status", "custo_unitario", "preco_venda", "fornecedor", "unidade_compra", "moq"]);
  requireColumns(rawSales, "vendas_diarias.csv", ["sku", "data", "unidades_vendidas", "receita"]);
  requireColumns(stockRows, "estoque_diario.csv", ["sku", "data", "estoque_disponivel"]);
  requireColumns(purchaseRows, "compras.csv", ["po_id", "fornecedor", "sku", "data_pedido", "data_recebimento", "quantidade", "unidade"]);
  const skus: Sku[] = skuRows.map((row) => ({
    sku: row.sku, brand: row.marca, description: row.descricao, category: row.categoria, status: row.status.toLowerCase(),
    unitCost: number(row.custo_unitario), retailPrice: number(row.preco_venda), supplier: row.fornecedor,
    purchaseUnit: row.unidade_compra, moq: number(row.moq),
  }));
  const salesByKey = new Map<string, Sale>();
  let salesDuplicateRows = 0;
  let salesDuplicateConflicts = 0;
  for (const row of rawSales) {
    const sale: Sale = { sku: row.sku, date: row.data, units: number(row.unidades_vendidas), revenue: number(row.receita) };
    const key = `${sale.sku}|${sale.date}`;
    const existing = salesByKey.get(key);
    if (existing) {
      salesDuplicateRows += 1;
      if (existing.units !== sale.units || existing.revenue !== sale.revenue) salesDuplicateConflicts += 1;
    } else salesByKey.set(key, sale);
  }
  const stock: StockRecord[] = stockRows.map((row) => ({ sku: row.sku, date: row.data, units: number(row.estoque_disponivel) }));
  const purchases: Purchase[] = purchaseRows.map((row) => ({
    id: row.po_id, supplier: row.fornecedor, sku: row.sku, orderDate: row.data_pedido,
    receiptDate: row.data_recebimento.trim() || null, quantity: number(row.quantidade), unit: row.unidade,
  }));
  return { skus, sales: [...salesByKey.values()], stock, purchases, salesDuplicateRows, salesDuplicateConflicts };
}

export function toUnits(quantity: number, unit: string, caseUnits: number): number {
  return quantity * (unit.trim().toLowerCase() === "cx 12 un" ? caseUnits : 1);
}
