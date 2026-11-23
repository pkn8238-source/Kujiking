#!/bin/bash
# Shibamaru Store(shop.yujin-llc.co.jp) 이치방쿠지 상품 이미지 다운로드
set -u
cd "$(dirname "$0")"
B=https://shop.yujin-llc.co.jp/api/kuji-img
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
dl(){ curl -sfL -A "$UA" -e "https://shop.yujin-llc.co.jp/kuji" "$B/$2.jpg" -o "$1/raw/$3.webp" && echo "$1/$3 ok" || echo "$1/$3 FAIL"; }
mkdir -p dragonball-saiyan/raw hunter-chimera-ant/raw jojo-rivals/raw apothecary-secret/raw

dl dragonball-saiyan 5577e0935819ea8b527a a
dl dragonball-saiyan 6cd94269e0680d3f77b2 b
dl dragonball-saiyan 5d87f376d4825497038f c
dl dragonball-saiyan 5fe3594652a746397db0 d
dl dragonball-saiyan 6494bf7ddb3c38875dda e
dl dragonball-saiyan bbcd11a0ff076f14522c f
dl dragonball-saiyan dc03188e53049155dc69 g
dl dragonball-saiyan adc7515aade2aa9a4746 h
dl dragonball-saiyan 77da2a79f7942229aaf6 i
dl dragonball-saiyan cd15e51a40cc52bdd00a j
dl dragonball-saiyan b63b762db3bbfe894d49 last

dl hunter-chimera-ant 3cd8dd2d306611a60380 a
dl hunter-chimera-ant f2e0e1f97088dbf0f0ad b
dl hunter-chimera-ant 48fcf523f06fd7f95500 c
dl hunter-chimera-ant 0f94bde32699897a712a d
dl hunter-chimera-ant 61bd2edb1cf2514f62ab e
dl hunter-chimera-ant 5bdae2fa5c281e1afc0b f
dl hunter-chimera-ant 3b3efcd6a5bf0ef9b633 g
dl hunter-chimera-ant 751e4ca9cdcc11657ca7 h
dl hunter-chimera-ant 3fc36350933ae6a397f6 i
dl hunter-chimera-ant 10e96792d9f203a1420b last

dl jojo-rivals 10b14cc16e6a4023dd61 a
dl jojo-rivals f9ebc02fe793adfacb4b b
dl jojo-rivals 69ff997f792beb5ce5d6 c
dl jojo-rivals 034a2da35a2c609534c6 d
dl jojo-rivals 2c67fe50309816fdc938 e
dl jojo-rivals 9cd3c02551bfd3cddcb1 f
dl jojo-rivals ada7f5dc230edac79368 g
dl jojo-rivals 1fb74efe4f3f98b62adb h
dl jojo-rivals ca3c2683cf9d2f7db78e i
dl jojo-rivals b3dee25e1d22f66d093d j
dl jojo-rivals db624fd7ebffb33303fd k
dl jojo-rivals 2bb37723acb371db3da0 l
dl jojo-rivals b1c8ab03c2204cfa6de3 last

dl apothecary-secret c18593637af531001bf2 a
dl apothecary-secret 097f6bc616c07f5bae8b b
dl apothecary-secret ab6dffd24b8fe0670471 c
dl apothecary-secret fb4aaf06d95bac5235ef d
dl apothecary-secret 4edab151fab588893ff7 e
dl apothecary-secret c6364336c9b1b94837ff f
dl apothecary-secret cb67a7486562231a5911 g
dl apothecary-secret 7fe5c032b710fdaeb751 h
dl apothecary-secret 3b81ab16e966b27404c2 last
