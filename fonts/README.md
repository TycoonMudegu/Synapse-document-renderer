# Template fonts

These open-source font families match the free font names in the existing uploaded templates. The corresponding SIL Open Font License notices are included alongside the fonts.

| Family | Upstream source | Included styles |
| --- | --- | --- |
| Inter | [Google Fonts / Inter](https://github.com/google/fonts/tree/main/ofl/inter) | Regular 400 and Bold 700, optical size 18 |
| Inconsolata | [Google Fonts / Inconsolata](https://github.com/google/fonts/tree/main/ofl/inconsolata) | Regular 400 and Bold 700, width 100 |
| Poppins | [Google Fonts / Poppins](https://github.com/google/fonts/tree/main/ofl/poppins) | Upstream static Regular and Bold |

Inter and Inconsolata were instantiated from the upstream variable fonts using fontTools 4.68.0. The static bold instances have their style/full/PostScript names set to Bold so font matching distinguishes them from Regular. No glyph outlines were otherwise changed.

The Docker image also installs distribution-packaged Carlito, Caladea, Liberation, DejaVu and OpenSymbol as available fallbacks. Proprietary Microsoft fonts are not bundled. Additional uploaded designs may require their own fonts and visual review.
