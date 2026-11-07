# ساخت عکس محصولات (public/img/*.png) و فایل seed_products.sql از روی tools/products.json
# اجرا: python tools/make_products.py https://golabeyasamin.emediastorbot.workers.dev
import json
import pathlib
import subprocess
import sys
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
NOTE = "⚠️ در دوران بارداری، شیردهی یا در صورت بیماری، پیش از مصرف با پزشک مشورت کنید."


def sql(value):
    return "'" + str(value).replace("'", "''") + "'"


def main():
    base_url = sys.argv[1].rstrip("/")
    products = json.loads((ROOT / "tools" / "products.json").read_text(encoding="utf-8"))
    out_dir = ROOT / "public" / "img"
    out_dir.mkdir(parents=True, exist_ok=True)
    template = (ROOT / "tools" / "product_card.html").as_uri()

    rows = []
    for pos, p in enumerate(products, start=1):
        params = {k: p[k] for k in ("title", "sub", "c1", "c2", "liquid", "accent", "motif", "label")}
        url = template + "#" + urllib.parse.quote(json.dumps(params, ensure_ascii=False))
        png = out_dir / f"{p['slug']}.png"
        subprocess.run(
            [EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1080,1080",
             "--virtual-time-budget=8000", f"--screenshot={png}", url],
            check=True, capture_output=True,
        )
        print("image:", png.name, png.stat().st_size)
        description = f"{p['description']}\n\n{NOTE}"
        rows.append(
            f"({sql(p['title'])}, {sql(description)}, {sql(f'{base_url}/img/{p['slug']}.png')}, {int(p['price'])}, {pos})"
        )

    seed = (
        "-- محصولات اولیه (ساخته‌شده با tools/make_products.py). فقط روی دیتابیس بدون محصول اجرا شود.\n"
        "INSERT INTO products (title, description, photo_file_id, price, position) VALUES\n"
        + ",\n".join(rows)
        + ";\n"
    )
    (ROOT / "seed_products.sql").write_text(seed, encoding="utf-8")
    print("seed_products.sql:", len(rows), "products")


main()
