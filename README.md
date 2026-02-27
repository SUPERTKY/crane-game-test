# crane-game-test
## スクリーンショット取得手順

このプロジェクトの画面確認用に、ローカルHTTPサーバを起動してから Playwright でスクリーンショットを取得できます。

1. サーバ起動
   - `python3 -m http.server 4173`
2. Playwright で取得（Firefox 推奨）
   - Chromium が環境依存でクラッシュする場合があるため、Firefox を使う手順を推奨します。

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.firefox.launch()
    page = browser.new_page(viewport={"width": 1365, "height": 900})
    page.goto("http://127.0.0.1:4173", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(3000)
    page.screenshot(path="artifacts/crane-game-firefox.png", full_page=True)
    browser.close()
```


## 開きにくさを自分でアレンジするには

`main.js` の以下を調整してください。

- `CLAW_PRESSURE_OPEN_HARDNESS`（新規）
  - **大きいほど開きにくい**
  - 目安: `0.85` = 開きやすい / `1.0` = 標準 / `1.15` = 少し開きにくい / `1.3` = かなり開きにくい

この値は、内部的に次の2つへ連動して反映されます。
- `CLAW_PASSIVE_OPEN_ACCEL_PER_KG`（値が下がる → 開きにくくなる）
- `CLAW_PASSIVE_OPEN_RESISTANCE`（値が上がる → 開きにくくなる）

まずは `1.15` から始めて、
- まだ開くなら `+0.05` ずつ上げる
- 開かなすぎるなら `-0.05` ずつ下げる

のように微調整するのがおすすめです。
