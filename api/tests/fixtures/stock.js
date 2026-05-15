// Fixtures réutilisables pour stock_items + stock_movements.

export async function seedStockItem(db, {
  name = 'Article Test',
  category = null,
  quantity = 10,
  threshold = 2,
  unit = 'pcs',
} = {}) {
  const { rows } = await db.query(
    `INSERT INTO stock_items (name, category, quantity, alert_threshold, threshold, unit)
     VALUES ($1, $2, $3, $4, $4, $5) RETURNING *`,
    [name, category, quantity, threshold, unit]
  )
  return rows[0]
}
