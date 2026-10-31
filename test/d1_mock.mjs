import { DatabaseSync } from 'node:sqlite';

// یه شبیه‌ساز سبک از D1 API روی node:sqlite، فقط برای تست محلی منطق db.js
// (خودِ D1 واقعی رو باید با wrangler d1 execute --local تست کرد، این فقط برای
// تایید صحت SQL و منطق جاوااسکریپت قبل از دیپلوی واقعیه)
//
// مثل D1 واقعی:
//   - همه‌ی متدها Promise برمی‌گردونن (پس درخواست‌های هم‌زمان سر هر await درهم می‌شن)
//   - batch() همه‌ی دستورها رو در یک تراکنش اجرا می‌کنه و در صورت خطا rollback می‌کنه
//   - bind() یه statement جدید برمی‌گردونه (statement اصلی قابل استفاده‌ی دوباره است)

export function makeD1(sqlitePath = ':memory:') {
  const raw = new DatabaseSync(sqlitePath);

  function makeStatement(sql, boundArgs = []) {
    const exec = {
      first() {
        const row = raw.prepare(sql).get(...boundArgs);
        return row === undefined ? null : row;
      },
      all() {
        return { results: raw.prepare(sql).all(...boundArgs) };
      },
      run() {
        const info = raw.prepare(sql).run(...boundArgs);
        return { meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) } };
      },
    };
    return {
      bind(...args) {
        return makeStatement(sql, args);
      },
      async first() {
        return exec.first();
      },
      async all() {
        return exec.all();
      },
      async run() {
        return exec.run();
      },
      _runSync: exec.run,
    };
  }

  function prepare(sql) {
    return makeStatement(sql);
  }

  async function batch(statements) {
    raw.exec('BEGIN');
    try {
      const results = statements.map((s) => s._runSync());
      raw.exec('COMMIT');
      return results;
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
  }

  return { prepare, batch, raw };
}
