# DiceBear (vendored)

The mayor's avatar is drawn on the Mac with DiceBear, so making or changing
one never reaches the internet.

- `core/`: `@dicebear/core` 11.0.0-rc.2 (`src/js/core/src` from
  github.com/dicebear/dicebear at 4db7af0), MIT License (`LICENSE`), without
  the schema validators (the definition and the options come from our code).
- `notionists.json`: the Notionists style definition from DiceBear's parity
  fixtures. Remix of "Notionists" (https://heyzoish.gumroad.com/l/notionists)
  by Zoish, licensed under CC0 1.0.
- `parity.json`: two of DiceBear's reference renders, checked in
  `src/lib/avatar.test.ts` so an update can't quietly change the drawings.
