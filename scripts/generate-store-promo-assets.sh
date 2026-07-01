#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/store-assets"
ICON="$ROOT/icons/icon128.png"
FONT="/System/Library/Fonts/Supplemental/Arial.ttf"
BOLD="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
BLACK="/System/Library/Fonts/Supplemental/Arial Black.ttf"

mkdir -p "$OUT_DIR"

# Chrome Web Store requirements:
# - Small promo tile: 440x280
# - Marquee promo tile: 1400x560
# - Screenshot: 1280x800 or 640x400
# - JPEG or 24-bit PNG, no alpha. PNG24 forces true RGB output.

magick -size 440x280 xc:"#F5F8FC" \
  -fill "#E7F0FF" -draw "circle 390,8 520,8" \
  -fill "#EAFBF4" -draw "circle 46,270 188,270" \
  \( "$ICON" -resize 58x58 \) -geometry +30+30 -composite \
  -font "$BLACK" -pointsize 34 -fill "#111827" -annotate +30+118 "Tabpane" \
  -font "$BOLD" -pointsize 17 -fill "#1F2937" -annotate +31+150 "The tab manager" \
  -font "$BOLD" -pointsize 17 -fill "#1F2937" -annotate +31+172 "for busy browsers." \
  -font "$FONT" -pointsize 12 -fill "#5B677A" -annotate +31+202 "Search tabs | manage groups" \
  -font "$FONT" -pointsize 12 -fill "#5B677A" -annotate +31+220 "Save sessions | clean windows" \
  -fill "#FFFFFF" -stroke "#D7E1EF" -strokewidth 1 -draw "roundrectangle 238,40 407,239 16,16" \
  -fill "#0B1020" -stroke none -draw "roundrectangle 250,58 395,226 12,12" \
  -fill "#111827" -draw "roundrectangle 250,58 395,86 12,12 rectangle 250,74 395,86" \
  -fill "#24324A" -draw "roundrectangle 264,68 315,76 4,4" \
  -fill "#336DFF" -draw "roundrectangle 350,65 381,79 7,7" \
  -fill "#151D2D" -stroke "#35D19A" -draw "roundrectangle 264,102 322,204 8,8" \
  -fill "#35D19A" -stroke none -draw "circle 274,116 277,116" \
  -font "$BOLD" -pointsize 8 -fill "#F8FAFC" -annotate +282+119 "Review" \
  -fill "#2C3A50" -draw "roundrectangle 274,133 310,139 3,3 roundrectangle 274,149 305,155 3,3 roundrectangle 274,165 313,171 3,3 roundrectangle 274,181 300,187 3,3" \
  -fill "#151D2D" -stroke "#6EA2FF" -draw "roundrectangle 332,102 381,204 8,8" \
  -fill "#6EA2FF" -stroke none -draw "circle 342,116 345,116" \
  -font "$BOLD" -pointsize 8 -fill "#F8FAFC" -annotate +350+119 "npm" \
  -fill "#6EA2FF" -draw "roundrectangle 342,133 370,139 3,3" \
  -fill "#2C3A50" -draw "roundrectangle 342,149 373,155 3,3 roundrectangle 342,165 366,171 3,3" \
  -alpha remove -alpha off PNG24:"$OUT_DIR/promo-small.png"

magick -size 1400x560 xc:"#F5F8FC" \
  -fill "#E8F1FF" -draw "circle 1190,56 1450,56" \
  -fill "#EAFBF4" -draw "circle 120,520 340,520" \
  -fill "#EEF4FB" -draw "rectangle 0,0 1400,560" \
  -fill "#E8F1FF" -draw "circle 1180,78 1424,78" \
  -fill "#EAFBF4" -draw "circle 134,520 340,520" \
  \( "$ICON" -resize 104x104 \) -geometry +92+82 -composite \
  -font "$BLACK" -pointsize 64 -fill "#111827" -annotate +92+260 "Tabpane" \
  -font "$BLACK" -pointsize 42 -fill "#111827" -annotate +92+320 "The tab manager for" \
  -font "$BLACK" -pointsize 42 -fill "#111827" -annotate +92+372 "busy browser windows." \
  -font "$FONT" -pointsize 25 -fill "#5B677A" -annotate +94+425 "See every open tab, organize Chrome tab groups," \
  -font "$FONT" -pointsize 25 -fill "#5B677A" -annotate +94+462 "and save sessions you can restore later." \
  -fill "#FFFFFF" -stroke "#DDE6F2" -strokewidth 1 -draw "roundrectangle 676,64 1288,496 22,22" \
  -fill "#0B1020" -stroke none -draw "roundrectangle 704,94 1262,466 16,16" \
  -fill "#111827" -draw "roundrectangle 704,94 1262,148 16,16 rectangle 704,126 1262,148" \
  -fill "#24324A" -draw "roundrectangle 732,112 842,126 7,7" \
  -fill "#172033" -stroke "#2B3852" -draw "roundrectangle 862,112 1092,126 7,7" \
  -fill "#336DFF" -stroke none -draw "roundrectangle 1116,108 1182,132 12,12" \
  -fill "#172033" -stroke "#2B3852" -draw "roundrectangle 1198,108 1236,132 12,12" \
  -fill "#151D2D" -stroke "#35D19A" -draw "roundrectangle 732,176 910,418 14,14" \
  -fill "#35D19A" -stroke none -draw "circle 755,202 762,202" \
  -font "$BOLD" -pointsize 16 -fill "#F8FAFC" -annotate +776+207 "Current window" \
  -fill "#2C3A50" -draw "roundrectangle 754,236 884,266 8,8 roundrectangle 754,286 870,298 6,6 roundrectangle 754,314 886,326 6,6 roundrectangle 754,342 846,354 6,6 roundrectangle 754,370 876,382 6,6" \
  -fill "#151D2D" -stroke "#6EA2FF" -draw "roundrectangle 934,176 1098,418 14,14" \
  -fill "#6EA2FF" -stroke none -draw "circle 956,202 963,202" \
  -font "$BOLD" -pointsize 16 -fill "#F8FAFC" -annotate +976+207 "npm" \
  -fill "#22304A" -draw "roundrectangle 956,236 1074,266 8,8" \
  -fill "#6EA2FF" -draw "roundrectangle 956,286 1070,298 6,6" \
  -fill "#62738A" -draw "roundrectangle 956,314 1056,326 6,6 roundrectangle 956,342 1074,354 6,6" \
  -fill "#203D77" -draw "roundrectangle 956,376 1032,398 11,11" \
  -font "$BOLD" -pointsize 12 -fill "#DDE7F4" -annotate +977+392 "tab group" \
  -fill "#151D2D" -stroke "#35D19A" -draw "roundrectangle 1122,176 1238,418 14,14" \
  -fill "#35D19A" -stroke none -draw "circle 1144,202 1151,202" \
  -font "$BOLD" -pointsize 16 -fill "#F8FAFC" -annotate +1164+207 "Saved" \
  -fill "#203445" -draw "roundrectangle 1144,236 1216,266 8,8" \
  -fill "#35D19A" -draw "roundrectangle 1144,286 1218,298 6,6" \
  -fill "#62738A" -draw "roundrectangle 1144,314 1214,326 6,6 roundrectangle 1144,342 1222,354 6,6" \
  -fill "#1F513D" -draw "roundrectangle 1144,376 1220,398 11,11" \
  -font "$BOLD" -pointsize 12 -fill "#DDE7F4" -annotate +1164+392 "session" \
  -fill "#FFFFFF" -stroke "#DDE6F2" -draw "roundrectangle 706,442 1258,488 16,16" \
  -fill "#111827" -stroke none -font "$BOLD" -pointsize 16 -annotate +730+471 "Search tabs" \
  -fill "#5B677A" -font "$FONT" -pointsize 16 -annotate +838+471 "Move tabs between groups and windows" \
  -alpha remove -alpha off PNG24:"$OUT_DIR/promo-marquee.png"

magick -size 1280x800 xc:"#090D16" \
  -fill "#0D1320" -draw "rectangle 0,0 1280,82" \
  -fill "#182033" -draw "rectangle 0,81 1280,82" \
  \( "$ICON" -resize 40x40 \) -geometry +42+22 -composite \
  -font "$BOLD" -pointsize 24 -fill "#F8FAFC" -annotate +96+51 "Tabpane" \
  -fill "#121A2A" -stroke "#263147" -strokewidth 1 -draw "roundrectangle 260,18 680,58 10,10" \
  -font "$FONT" -pointsize 17 -fill "#7F8EA6" -annotate +302+44 "Search tabs by title or URL..." \
  -fill "#4F7CFF" -stroke none -draw "roundrectangle 1080,18 1148,58 10,10" \
  -font "$BOLD" -pointsize 16 -fill "#FFFFFF" -annotate +1102+44 "Save" \
  -fill "#121A2A" -stroke "#263147" -draw "roundrectangle 706,18 780,58 10,10 roundrectangle 794,18 892,58 10,10 roundrectangle 906,18 1024,58 10,10 roundrectangle 1162,18 1240,58 10,10" \
  -font "$BOLD" -pointsize 16 -fill "#E5ECF8" -annotate +728+44 "24 tabs" \
  -annotate +818+44 "3 windows" \
  -fill "#F5A524" -annotate +930+44 "0" \
  -fill "#AEB9CC" -annotate +950+44 "duplicates" \
  -fill "#C9D4E8" -annotate +1178+44 "Sessions" \
  -fill "#151B27" -stroke "#273246" -draw "roundrectangle 48,120 390,736 16,16" \
  -fill "#1A2230" -stroke none -draw "roundrectangle 48,120 390,168 16,16 rectangle 48,148 390,168" \
  -fill "#8B9AB1" -font "$BOLD" -pointsize 16 -annotate +76+151 "Window 1" \
  -font "$BOLD" -pointsize 15 -fill "#78869D" -annotate +342+151 "9" \
  -fill "#222B3B" -draw "roundrectangle 78,196 106,224 7,7 roundrectangle 78,258 106,286 7,7 roundrectangle 78,320 106,348 7,7 roundrectangle 78,382 106,410 7,7 roundrectangle 78,444 106,472 7,7 roundrectangle 78,506 106,534 7,7 roundrectangle 78,568 106,596 7,7" \
  -font "$BOLD" -pointsize 17 -fill "#E7EEFB" -annotate +124+216 "Product roadmap" \
  -font "$FONT" -pointsize 14 -fill "#68768D" -annotate +124+237 "docs.example.com/roadmap" \
  -font "$BOLD" -pointsize 17 -fill "#E7EEFB" -annotate +124+278 "Launch checklist" \
  -font "$FONT" -pointsize 14 -fill "#68768D" -annotate +124+299 "tasks.example.com/checklist" \
  -font "$BOLD" -pointsize 17 -fill "#E7EEFB" -annotate +124+340 "Customer notes" \
  -font "$FONT" -pointsize 14 -fill "#68768D" -annotate +124+361 "crm.example.com/notes" \
  -font "$BOLD" -pointsize 17 -fill "#E7EEFB" -annotate +124+402 "Release plan" \
  -font "$FONT" -pointsize 14 -fill "#68768D" -annotate +124+423 "github.com/team/release" \
  -font "$BOLD" -pointsize 17 -fill "#E7EEFB" -annotate +124+464 "Analytics report" \
  -font "$FONT" -pointsize 14 -fill "#68768D" -annotate +124+485 "analytics.example.com" \
  -font "$BOLD" -pointsize 17 -fill "#E7EEFB" -annotate +124+526 "Design review" \
  -font "$FONT" -pointsize 14 -fill "#68768D" -annotate +124+547 "figma.com/review" \
  -font "$BOLD" -pointsize 17 -fill "#E7EEFB" -annotate +124+588 "Support queue" \
  -font "$FONT" -pointsize 14 -fill "#68768D" -annotate +124+609 "help.example.com" \
  -fill "#151B27" -stroke "#4F7CFF" -strokewidth 2 -draw "roundrectangle 422,120 766,736 16,16" \
  -fill "#1A2230" -stroke none -draw "roundrectangle 422,120 766,168 16,16 rectangle 422,148 766,168" \
  -fill "#36D399" -draw "circle 452,144 459,144" \
  -font "$BOLD" -pointsize 16 -fill "#F8FAFC" -annotate +474+151 "Current window (To Review)" \
  -font "$BOLD" -pointsize 15 -fill "#78869D" -annotate +720+151 "15" \
  -fill "#8B9AB1" -font "$BOLD" -pointsize 13 -annotate +474+198 "TO REVIEW" \
  -fill "#22304A" -draw "roundrectangle 474,218 502,246 7,7 roundrectangle 474,280 502,308 7,7 roundrectangle 474,342 502,370 7,7 roundrectangle 474,404 502,432 7,7 roundrectangle 474,466 502,494 7,7 roundrectangle 474,528 502,556 7,7 roundrectangle 474,590 502,618 7,7" \
  -font "$BOLD" -pointsize 17 -fill "#E7EEFB" -annotate +520+238 "Research links" \
  -font "$FONT" -pointsize 14 -fill "#68768D" -annotate +520+259 "review.example.com/research" \
  -font "$BOLD" -pointsize 17 -fill "#E7EEFB" -annotate +520+300 "Pull request" \
  -font "$FONT" -pointsize 14 -fill "#68768D" -annotate +520+321 "github.com/team/project/pull" \
  -font "$BOLD" -pointsize 17 -fill "#E7EEFB" -annotate +520+362 "Dependency notes" \
  -font "$FONT" -pointsize 14 -fill "#68768D" -annotate +520+383 "npmjs.com/package/example" \
  -font "$BOLD" -pointsize 17 -fill "#E7EEFB" -annotate +520+424 "QA checklist" \
  -font "$FONT" -pointsize 14 -fill "#68768D" -annotate +520+445 "docs.example.com/qa" \
  -font "$BOLD" -pointsize 17 -fill "#E7EEFB" -annotate +520+486 "Status dashboard" \
  -font "$FONT" -pointsize 14 -fill "#68768D" -annotate +520+507 "status.example.com" \
  -font "$BOLD" -pointsize 17 -fill "#E7EEFB" -annotate +520+548 "Release notes" \
  -font "$FONT" -pointsize 14 -fill "#68768D" -annotate +520+569 "docs.example.com/releases" \
  -font "$BOLD" -pointsize 17 -fill "#E7EEFB" -annotate +520+610 "Customer feedback" \
  -font "$FONT" -pointsize 14 -fill "#68768D" -annotate +520+631 "feedback.example.com" \
  -fill "#0F1420" -stroke "#273246" -strokewidth 1 -draw "roundrectangle 810,120 1232,736 16,16" \
  -font "$BOLD" -pointsize 22 -fill "#F8FAFC" -annotate +846+165 "Saved sessions" \
  -fill "#4F7CFF" -stroke none -draw "roundrectangle 1082,132 1196,174 10,10" \
  -font "$BOLD" -pointsize 16 -fill "#FFFFFF" -annotate +1106+159 "Save current" \
  -font "$FONT" -pointsize 16 -fill "#7F8EA6" -annotate +846+205 "Reopen your saved tabs later. Synced with" \
  -annotate +846+229 "your Chrome profile when Chrome Sync is on." \
  -fill "#151B27" -stroke "#273246" -draw "roundrectangle 846,274 1196,358 12,12 roundrectangle 846,388 1196,472 12,12 roundrectangle 846,502 1196,586 12,12" \
  -font "$BOLD" -pointsize 18 -fill "#E7EEFB" -annotate +874+309 "Weekly research" \
  -font "$FONT" -pointsize 14 -fill "#718096" -annotate +874+333 "8 tabs | 2 groups | Saved today" \
  -font "$BOLD" -pointsize 18 -fill "#E7EEFB" -annotate +874+423 "Product planning" \
  -font "$FONT" -pointsize 14 -fill "#718096" -annotate +874+447 "12 tabs | 3 groups | Synced" \
  -font "$BOLD" -pointsize 18 -fill "#E7EEFB" -annotate +874+537 "Launch review" \
  -font "$FONT" -pointsize 14 -fill "#718096" -annotate +874+561 "6 tabs | 1 group | Ready to reopen" \
  -fill "#0B1020" -stroke "#22304A" -draw "roundrectangle 846,638 1196,694 14,14" \
  -font "$BOLD" -pointsize 16 -fill "#F8FAFC" -annotate +874+672 "Move tabs. Rename groups. Save sessions." \
  -alpha remove -alpha off PNG24:"$OUT_DIR/screenshot-main.png"

magick identify -format '%f %wx%h %[channels] %[colorspace]\n' \
  "$OUT_DIR/promo-small.png" \
  "$OUT_DIR/promo-marquee.png" \
  "$OUT_DIR/screenshot-main.png"
