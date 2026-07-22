// Reversa del lote duplicado "Recepciones_Consolidadas_2026-07-21_Full" (2026-07-21 21:07Z).
//
// Ese lote del modulo liquidador reingreso mercancia que ya estaba contada en
// el inventario (ej: SalPip-460 tenia 8 y quedo en 16). El liquidador no tiene
// opcion de reversar, asi que este script deshace el lote replicando la logica
// del dashboard (inventoryCommitNeon.ts del repo nexus clone):
//
//  - InventoryItem: resta las unidades de onHandLocalQty, revierte el costo
//    promedio ponderado y recalcula totalValueCop (misma formula del dashboard:
//    suma de todas las ubicaciones x avgCost).
//  - InventoryLot: consume primero los lotes creados por el lote duplicado
//    (mismo timestamp/sourceType LIQUIDATION); si ya se vendio parte, el resto
//    sale FIFO de los lotes mas antiguos (igual que hace el dashboard).
//  - InventoryMovement: inserta un OUT negativo con
//    metadata.reversalOfMovementId apuntando al IN original (concepto nativo
//    del dashboard para reversas).
//
// Uso:
//   node revert_liquidation_2026-07-21.cjs                          <- dry-run de todo el lote
//   node revert_liquidation_2026-07-21.cjs --skus=SalPip-460,...    <- dry-run solo de esos SKUs
//   node revert_liquidation_2026-07-21.cjs --skus=... --apply       <- ejecuta (transaccion)
const fs = require("fs");
const { Pool } = require("./functions/node_modules/pg");

const APPLY = process.argv.includes("--apply");
const skusArg = (process.argv.find((a) => a.startsWith("--skus=")) || "").slice(7);
const ONLY = new Set(skusArg.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const BATCH_REF = "Recepciones_Consolidadas_2026-07-21_Full";
const REASON = "Reversa liquidacion duplicada (mercancia ya contada en stock)";

const url = fs.readFileSync("C:/Users/Admin/Dashboard/nexus clone/Nexus/dashboard-src/functions/.env", "utf8")
  .match(/^NEON_DATABASE_URL=(.+)$/m)[1].trim().replace(/^"|"$/g, "");
const pool = new Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const newId = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

(async () => {
  const client = await pool.connect();
  try {
    const { rows: ins } = await client.query(`
      select id, sku, qty, "unitCostCop", "createdAt"
      from public."InventoryMovement"
      where channel = 'LIQUIDATOR' and reference = $1 and type = 'IN'
      order by sku`, [BATCH_REF]);
    if (!ins.length) { console.log("No hay movimientos IN de ese lote (¿ya reversado?)."); return; }
    console.log(`Movimientos IN del lote: ${ins.length}\n`);

    if (APPLY) await client.query("begin");
    const report = [];

    for (const mov of ins) {
      const sku = mov.sku;
      if (ONLY.size && !ONLY.has(sku.toLowerCase())) continue;
      const dupQty = n(mov.qty);
      const { rows: [item] } = await client.query(
        `select * from public."InventoryItem" where sku = $1 ${APPLY ? "for update" : ""}`, [sku]);
      if (!item) { report.push({ sku, estado: "SIN ITEM — omitido" }); continue; }

      const local = n(item.onHandLocalQty);
      if (local < dupQty) {
        report.push({ sku, in: dupQty, local, estado: "INSUFICIENTE — omitido (revisar a mano)" });
        continue;
      }

      // Lotes del lote duplicado (mismo instante y origen), luego FIFO antiguo.
      const { rows: batchLots } = await client.query(`
        select id, "qtyAvailable", "unitCostCop" from public."InventoryLot"
        where sku = $1 and "sourceType" = 'LIQUIDATION' and "createdAt" = $2 and "qtyAvailable" > 0
        order by "createdAt"`, [sku, mov.createdAt]);
      const { rows: oldLots } = await client.query(`
        select id, "qtyAvailable", "unitCostCop" from public."InventoryLot"
        where sku = $1 and "qtyAvailable" > 0 and not (("sourceType" = 'LIQUIDATION') and ("createdAt" = $2))
        order by "createdAt"`, [sku, mov.createdAt]);

      let remaining = dupQty;
      const lotPlan = [];
      for (const lot of [...batchLots, ...oldLots]) {
        if (remaining <= 0) break;
        const take = Math.min(n(lot.qtyAvailable), remaining);
        if (take > 0) { lotPlan.push({ id: lot.id, take, nuevo: n(lot.qtyAvailable) - take }); remaining -= take; }
      }

      // Costo promedio: revierte la ponderacion del IN (misma formula inversa).
      const unitCost = n(mov.unitCostCop);
      const stockForValue = ["onHandLocalQty","onHandFullQty","inboundLocalQty","inboundFullQty",
        "onHandMarketQty","onHandUsaQty","onHandLoanQty","defectiveQty"]
        .reduce((s, c) => s + n(item[c]), 0);
      const avgNow = n(item.avgCostCop);
      const stockAfter = stockForValue - dupQty;
      let avgAfter = avgNow;
      if (unitCost > 0 && stockAfter > 0) {
        avgAfter = Math.max(0, Math.round((stockForValue * avgNow - dupQty * unitCost) / stockAfter));
      }
      const newLocal = local - dupQty;
      const newTotalValue = Math.round(Math.max(0, stockAfter) * avgAfter);

      report.push({
        sku, in: dupQty, local, queda: newLocal,
        lotes: lotPlan.map((l) => `${l.id}:-${l.take}`).join(" ") || "(sin lotes)",
        avg: `${avgNow} -> ${avgAfter}`,
        estado: remaining > 0 ? `AVISO: faltaron ${remaining} en lotes (solo item ajustado)` : "ok",
      });

      if (!APPLY) continue;

      const negFlag = newLocal < 0 ||
        ["onHandFullQty","inboundLocalQty","inboundFullQty","onHandMarketQty",
         "onHandUsaQty","onHandLoanQty","defectiveQty"].some((c) => n(item[c]) < 0);

      for (const l of lotPlan) {
        await client.query(
          `update public."InventoryLot" set "qtyAvailable" = $1 where id = $2`,
          [l.nuevo, l.id]);
      }
      await client.query(`
        update public."InventoryItem"
        set "onHandLocalQty" = $1, "avgCostCop" = $2, "totalValueCop" = $3,
            "updatedAt" = now(), "negativeStockFlag" = $4
        where sku = $5`, [newLocal, avgAfter, newTotalValue, negFlag, sku]);
      await client.query(`
        insert into public."InventoryMovement"
          (id, type, sku, qty, "sourceType", "sourceId", reference, channel, location,
           "reasonCode", "unitCostCop", "totalCostCop", "createdAt", "effectiveAt", metadata)
        values ($1, 'OUT', $2, $3, 'INVENTORY_ADJUST', $4, $5, 'MANUAL', 'WAREHOUSE',
           'REVERSAL', $6, $7, now(), now(), $8)`,
        [newId("mov"), sku, -dupQty, BATCH_REF, REASON, unitCost, Math.round(dupQty * unitCost),
         JSON.stringify({
           previousQty: local, newQty: newLocal,
           previousAvgCost: avgNow, newAvgCost: avgAfter,
           reversalOfMovementId: mov.id, batchRef: BATCH_REF,
         })]);
    }

    if (APPLY) await client.query("commit");
    console.table(report);
    console.log(APPLY ? "\nAPLICADO (transaccion confirmada)." : "\nDRY-RUN — nada se escribio. Ejecuta con --apply para aplicar.");
  } catch (e) {
    if (APPLY) await client.query("rollback").catch(() => {});
    console.error("ERROR (rollback):", e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
