# 桌宠

这是一个以我常用头像为角色制作的简单的桌宠，是一份送给朋友的礼物。  
角色的动作视频主要通过 **豆包**生成，再转换为透明 PNG 序列进行播放。

## 主要功能
- 常驻桌面、透明背景、可拖拽移动
- 右上角关闭按钮（点击即退出整个程序）
- 单击触发：`wink`
- 双击触发：`blush`
- **无人点击时**：每 **15 秒**从 `dull/cry/yawn` 中随机播放一个  
  （播放结束后重新从 0 秒计时）
- 配置化：动作、间隔、帧率、冷却时间等都可在 `app/config.json` 修改

## 实现方式
- **技术栈**：Electron（Windows）
- **渲染**：PNG 序列帧播放（透明通道）
- **动作逻辑**：基于定时器与点击事件触发
- **视频转序列**：`scripts/mp4_to_png.py`，使用 `av + pillow + numpy`

## 项目结构（简化）
```
app/
  main.js          # 主进程
  renderer.js      # 播放与交互逻辑
  config.json      # 动作配置
  index.html       # 页面
  styles.css       # 样式
assets/
  ori.png          # idle 静态图
  frames/
    dull/ cry/ yawn/ ...
scripts/
  mp4_to_png.py    # 视频转 PNG 序列
```

## 使用方式

### 1) 直接运行（开发模式）
需要 **安装依赖**：
- Node.js + npm
- 若要转视频：Python + `av` + `pillow` + `numpy`

```bash
npm install
npm start
```

### 2) 使用打包后的 exe
- **不需要安装依赖**  
- 直接运行安装包 `*Setup*.exe` 即可

安装完成后会生成快捷方式，双击即可启动。

### 3) 打包成安装包（仓库不包含 dist）

本地打包步骤：
```bash
npm install
npm run build -- --win nsis
```
生成的安装包：
```
dist\*Setup*.exe
```

如果打包时报错 `Cannot create symbolic link`：
- 用 **管理员 PowerShell** 运行，或
- 开启 Windows **开发者模式**

---

## 视频转 PNG（可选）
如果你有新的动作视频（透明背景），可以这样导出：

```bash
python scripts/mp4_to_png.py --input-dir output_transparent_v2 --outdir assets/frames
```

（需要安装：`av + pillow + numpy`）

---

## 自定义动作/频率
编辑 `app/config.json`：
```json
"triggers": {
  "autoIntervalSec": 15,
  "autoPool": ["dull", "cry", "yawn"]
}
```



## demo视频

[pet_example.mp4](pet_example.mp4)

