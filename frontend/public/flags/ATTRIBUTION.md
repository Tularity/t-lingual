# Language icons

The circular flag assets in this directory originate from HatScripts' `circle-flags` project, licensed under the MIT License in [LICENSE.md](./LICENSE.md). The resource mapping follows the local `Tularity/asr-live-session/frontend/static/static/flags/languages.json` catalogue. Its fully embedded SVG assets were copied from that checkout. Twenty-four upstream `lang-*.svg` entries were unresolved text pointers to country files absent from that checkout; those corresponding country SVGs were copied from HatScripts `circle-flags` commit `379588b` and given the resolved language filenames here. Norwegian uses the Bokmål mapping; English uses the Australian icon. Chinese (Traditional) uses `tw.svg` and Cantonese uses `hk.svg`, following that catalogue.

The neutral `globe.svg` for automatic or multiple languages is original to this project and is not a country flag.

Lithuanian, Estonian, and Maltese icons were resolved from the same upstream `flags/lt.svg`, `flags/ee.svg`, and `flags/mt.svg` on its gh-pages branch on 2026-09-24; the local checkout entries were unresolved pointers. Ukrainian and Latvian embedded SVGs were copied from the local structural upstream. Bokmål and Nynorsk share the Norwegian flag.
