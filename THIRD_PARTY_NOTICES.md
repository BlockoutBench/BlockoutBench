# 第三方组件

## three.js r128

`vendor/three.min.js`，3D 视图使用。原始版权与许可证头保留在文件开头。

```
The MIT License

Copyright © 2010-2021 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 桌面运行时与开发测试依赖

| 组件 | 用途 | 许可证 |
|---|---|---|
| Electron | 桌面版外壳（`desktop/`，源码包需 `npm install`；完整桌面发行包随 `desktop/node_modules/electron/dist/` 分发） | MIT；随包附带的 `LICENSE` 与 Chromium 等第三方组件的 `LICENSES.chromium.html` 均位于 `desktop/node_modules/electron/dist/` |
| Playwright | 仅用于开发者本地回归测试（根目录 `npm install`），不随桌面发行包运行 | Apache-2.0 |

分发完整可运行桌面发行包时，必须保留 `desktop/node_modules/electron/dist/LICENSE` 与 `LICENSES.chromium.html`。
