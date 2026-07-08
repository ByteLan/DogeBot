Style sticker font assets
========================

This directory is copied to `dist/assets/fonts` during `apps/server` builds.

- `DouyinSansBold.woff2`: style sticker display font.
- `YouSheBiaoTiHei.ttf`: style sticker display font.
- `AppleColorEmoji.ttf`: subsetted Apple emoji fallback font with only the 160 ppem strike kept, loaded first. Glyphs outside the subset fall back to Noto emoji fonts.
- `AppleSymbols.ttf`: Apple symbol fallback font, loaded first.
- `NotoColorEmoji.ttf`: emoji fallback font from Google Noto Emoji.
- `NotoSansSymbols2-Regular.ttf`: symbol fallback font from Google Noto Fonts.

The Noto fallback fonts are distributed under the SIL Open Font License 1.1.
The Apple fallback fonts are bundled for this private deployment with explicit project authorization.
