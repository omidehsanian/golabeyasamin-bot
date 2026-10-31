// محصول تستی با id ثابت در جدول products (جای setProductSetting نسخه‌ی قبلی)
export async function setTestPrice(env, id, price) {
  await env.DB.prepare(
    `INSERT INTO products (id, title, description, photo_file_id, price, position) VALUES (?, ?, 'ویژگی تستی', '', ?, ?)
     ON CONFLICT(id) DO UPDATE SET price = excluded.price`
  )
    .bind(Number(id), `محصول ${id}`, Number(price), Number(id))
    .run();
}
