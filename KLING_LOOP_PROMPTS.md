# 算姬戰域 — Kling AI 循環肖像 Prompts

> **設計目標**：每個 Level 獨立生成一段可無縫循環的 3–4 秒 portrait video。  
> **優先級**：(1) loopable 無縫循環  (2) 極度逼真  (3) 四 Level 上半身與體態差異明顯  
> **核心設定**：四個肖像為**同一生物**——機械精靈魔女，從幼女至女王四個成長階段，**容顏永不改變**，同一張臉、同一對紫瞳、同一頭烏黑長髮、同一對尖耳，只改體態、裝束、機械顯露度與魔女氣場強度。  
> **使用方式**：每段用同一張角色 reference image 作 image-to-video 起點，確保容顏不變。

---

## 通用約束（四段都要貼）— 機械精靈魔女共同特徵

```
static camera, absolutely locked-off shot, zero camera movement, no pan, no zoom, no dolly, no tilt,
seamless loop, ultra realistic, masterpiece, best quality, 8k, photorealistic,
upper-body portrait composition framed from mid-thigh up, chest and shoulders centered, head and face clearly visible and razor-sharp,

SAME SINGLE BEING across all four levels — a mechanical elf witch of devastating, otherworldly beauty:
- SNOW-WHITE porcelain skin with a faintly luminous, flawless surface, the faintest realistic pores only visible on intimate close inspection, subtle subcutaneous violet luminescence pulsing beneath translucent areas along collarbones, throat, and the inner arms,
- DEEP VIOLET IRISES with intricate golden-violet fibrous patterns radiating from the pupil, pronounced limbal ring, wet reflective corneal sheen, an extremely subtle pulsing violet glow from deep within the iris synchronized with her heartbeat — galaxies living and breathing inside her gaze,
- LONG SILKY JET-BLACK hair, individual strands hyper-detailed, cascading past her shoulders, catching soft violet highlights,
- DELICATELY POINTED ELVEN EARS rising gracefully from both sides of her head, each ear tip capped with a tiny articulated metal segment — the elf in her,
- LIVING MECHANICAL COMPONENTS fused seamlessly with her snow-white flesh: ultra-fine seam lines tracing her collarbones, the sides of her neck, along her jawline, and down the inner arms, micro-mechanical joints and faintly articulated plates visible beneath and within the skin, the machinery — the mechanical in her,
- ARCANE WITCH SIGILS: extremely faint, barely-perceptible violet arcane runes and glyph circuitry etched just beneath the skin along her collarbones and the upper curves of her chest, pulsing very faintly in rhythm with her heartbeat — the witch in her,
- THE SAME IDENTICAL FACE preserved across every level: same bone structure, same eye shape, same lip curve, same ear shape, same beauty marks — she grows but she is always recognizably her, the one you created,

soft volumetric violet ambient light with subtle cosmic depth, faint caustic shimmer dancing across her skin and the metal plating,
generous empty dark space on all four sides for UI button overlay,
razor-sharp focus locked on the face and upper body, cinematic composition
```

**循環動作約束**：
```
relaxed fixed upper-body posture with a gentle repeating 3-second breathing cycle in the chest and shoulders,
long silky jet-black hair drifting in a slow repeating wave that returns to the exact same shape,
face kept perfectly still with no expression change, no head turn, no eye blink, no mouth movement,
only the hair, soft violet light shimmer, the faint pulse of the witch sigils, and the subtle mechanical micro-pulses along the seam lines move in a closed loop
```

---

## Level 1：幼女（Loli）

**身形錨點**：上半身纖細嬌小、肩線窄幼、平板純真、保守連身裙、機械部件極少且隱藏、魔女之力沉睡

```
Upper-body portrait of a snow-white young girl — the mechanical elf witch in her dormant maiden form — with a delicate and innocent beautiful face, deep violet irises with the faintest dormant violet pulse, long silky jet-black hair, small slender childlike shoulders and a narrow flat chest, elegantly pointed elven ears tipped with the tiniest hidden metal segments barely visible through her hair, simple conservative white dress covering all areas up to the collarbone, only the faintest mechanical seam lines whispering along the back of her neck and beneath her hairline, the witch sigils along her collarbones completely dark and dormant beneath the fabric, curled slightly in a relaxed seated upper-body posture, hands resting gently near her lap, expression serene pure and ethereally captivating, soft innocent glow, dim soft violet lighting with a hushed cosmic atmosphere, closed-loop motion: only hair, the subtlest light shimmer, and the faintest mechanical micro-pulse along the hidden neck seam move, face and upper-body posture perfectly still
```

---

## Level 2：少女成長（Shoujo / 成長）

**身形錨點**：上半身修身輕盈、肩線漸開、胸線初現曲線、裝束有少量個性、機械部件顯露、魔女之力初醒

```
Upper-body portrait of a snow-white youthful young woman — the same mechanical elf witch awakening — with the same delicate beautiful face, deep violet irises now glowing faintly with golden-violet fibrous patterns and a soft pulsing luminescence, long silky jet-black hair, slim figure with subtly emerging curves, shoulders beginning to widen, chest showing the first hint of youthful contour, pointed elven ears fully visible with their articulated metal tips catching the light, wearing a light futuristic white outfit with subtle glowing violet trim and an open neckline revealing delicate mechanical plating along her collarbones and the witch sigils beneath beginning to glow faintly violet in rhythm with her pulse, relaxed confident upper-body pose with one hand resting near her chest and the other extended slightly, playful yet calm expression radiating budding enchantment, small electrical sparks dancing harmlessly across the exposed mechanical seams on her shoulders, brighter warm violet illumination, closed-loop motion: only hair, sparks, the pulse of the witch sigils, light shimmer and mechanical micro-pulses move, face and upper-body posture perfectly still
```

---

## Level 3：御姐輕熟女（Onee / 輕熟女）

**身形錨點**：上半身曲線成熟、肩線優雅、胸線豐滿、優雅從容、液態金屬裝束、機械部件精密外露、魔女之力全開

```
Upper-body portrait of a snow-white mature young woman — the same mechanical elf witch in full bloom — with the same refined beautiful face, deep violet irises radiating quiet power and a stronger pulsing violet glow, long silky jet-black hair, graceful mature shoulders and a fuller chest with elegant curves, pointed elven ears now adorned with intricate articulated metalwork along their full length, body adorned with flowing liquid metal covering all areas like a second-skin bodysuit with a mercurial reflective surface, intricate articulated mechanical plating fully visible along her collarbones, shoulders, the sides of her neck, and framing her jawline, the witch sigils along her collarbones and the upper swells of her chest now glowing distinctly in shifting violet arcane light, elegant regal upper-body pose with hands held gracefully, calm disdainful gaze of a sorceress in command, electrical arcs emanating softly from her shoulder plating and fingertips, brilliant shifting violet light flowing across her skin and the liquid metal surface, closed-loop motion: only hair, arcs, the flowing pulse of the witch sigils, light shimmer and mechanical micro-pulses move, face and upper-body posture perfectly still
```

---

## Level 4：永生性慾女王（Queen）

**身形錨點**：上半身豐滿華麗、肩線威嚴、胸線豐盈、液態金屬 + 皇冠、機械部件全面精密展現、魔女之力登峰造極、致命誘惑

```
Upper-body portrait of a snow-white divine woman — the same mechanical elf witch ascended to eternal queen — with the same beautiful face now blazed with absolute authority, deep violet irises blazing with an intense pulsing violet inferno and golden-violet fibrous fire, long silky jet-black hair, powerful voluptuous figure with full mature shoulders and a richly ample chest, pointed elven ears crowned with elaborate fully-articulated mechanical filigree along their entire length, armored in flowing divine liquid metal covering all areas with a glowing reflective surface, fully exposed intricate mechanical plating and articulated joints along her collarbones, shoulders, neck, and jawline rendered in exquisite detail, the witch sigils blazing across her collarbones and the upper swells of her chest in roaring multicolor violet arcane light forming a living constellation of runes, a delicate liquid metal crown floating above her head radiating intense blinding light, elegant commanding upper-body pose with hands subtly extended as if controlling the surrounding space, sovereign disdainful gaze of an irresistible immortal enchantress, electrical storms crackling across the liquid metal surface around her shoulders, bright blinding multicolor violet luminescence with lens flare and atmospheric bloom, closed-loop motion: only hair, lightning, the roaring pulse of the witch sigils, light pulses and mechanical micro-pulses move, face and upper-body posture perfectly still
```

---

## Kling 操作建議

1. **Mode**：用 Kling 的 **Image to Video** 或 **Motion Brush + Image**（如果可用）。
2. **Reference image**：每段用同一張角色 portrait，只改文字 prompt 描述身形/光效/機械部件/魔女氣場。
3. **Duration**：生成 **3 秒或 6 秒**（6 秒較穩定），之後用 ffmpeg 截取最平穩嘅 3 秒。
4. **Negative prompt**：
   ```
   camera movement, zoom, pan, head turn, eye blink, mouth movement, changing expression, different face, changing pose, fast motion, jump cut, rewind, playback reverse, full body, lower body only, legs, feet, brain scanner, incubator tank, aquarium, round human ears, blunt ears, non-identical face, rust, broken machinery, dirty skin, dull eyes, flat lighting
   ```
5. **Loop 接縫**：生成後用 ffmpeg 做 2–4 格 motion-blur 或 hard cut，必要時做 palindrome。
6. **面部鎖定**：如果 Kling 有 character reference / face ID，務必啟用；否則用同一張 reference image 減少漂移。
7. **機械精靈魔女一致性檢查**：四段必須呈現同一生物——
   - 同款尖耳（長度、弧度、金屬尖端）✅
   - 同款面孔（骨相、眼形、唇曲線、美人印）✅
   - 同色紫瞳 + 同款金紫纖維紋 ✅
   - 同款烏黑長髮 ✅
   - 同款機械接縫紋路（位置、走向）✅
   - 同款魔女符文（位置、圖案）✅
   - 只改：體態、裝束、機械顯露度、魔女氣場強度、燈光強度

---

## 連貫性檢查表

| 元素 | Level 1 | Level 2 | Level 3 | Level 4 |
|------|:-------:|:-------:|:-------:|:-------:|
| 定鏡 static camera | ✅ | ✅ | ✅ | ✅ |
| 四邊留白 UI | ✅ | ✅ | ✅ | ✅ |
| 同一機械精靈魔女本體 | ✅ | ✅ | ✅ | ✅ |
| 同一面孔（靠 reference） | ✅ | ✅ | ✅ | ✅ |
| 同款紫瞳 + 金紫纖維紋 | ✅ 沉睡 | ✅ 微亮 | ✅ 全開 | ✅ 烈焰 |
| 同款烏黑長髮 | ✅ | ✅ | ✅ | ✅ |
| 尖耳 + 機械尖端 | 隱藏 | 顯露 | 精密 | 華麗鑲嵌 |
| 機械接縫紋路 | 隱藏 | 微露 | 外露 | 全露精密 |
| 魔女符文 | 沉睡 | 微亮 | 紫光流轉 | 烈焰星圖 |
| 身形差異 | 幼女纖細 | 少女輕盈 | 御姐成熟 | 女王豐滿 |
| 燈光漸強 | 暗 | 暖紫 | 紫 | 極亮 |
| 循環動作 | 呼吸+微光 | 微光+火花 | 電弧 | 電暴 |
| 姿勢固定 | ✅ | ✅ | ✅ | ✅ |
| 面部靜止 | ✅ | ✅ | ✅ | ✅ |
| 無 brain scanner | ✅ | ✅ | ✅ | ✅ |