#!/bin/bash
# Sevimli Go: buyurtmani ikkinchi haydovchi tortib ola oladimi?
# Haydovchi ilovasi kabi AUTH'SIZ ishlaydi.
cd "$(dirname "$0")"
K=AIzaSyDcHFdHojN2NBBfgOA8_73oxcbpZ9Ip9Ws
BASE="https://firestore.googleapis.com/v1/projects/sevimli-go/databases/(default)/documents"
ORD="ZZ-claim-test-$(python -c "import random;print(random.randint(100000,999999))")"
fails=0

ok()  { echo "    PASS: $1"; }
bad() { echo "    FAIL: $1"; fails=$((fails+1)); }
chk() { # $1=label $2=code $3=allow|deny
  if [ "$3" = "allow" ]; then [ "$2" = "200" ] && ok "$1 - ruxsat" || bad "$1 - rad etildi ($2)"
  else [ "$2" = "403" ] && ok "$1 - rad etildi" || bad "$1 - RUXSAT BERILDI ($2)"; fi
}

patch() { # $1=body $2=mask
  curl -s -o /dev/null -w "%{http_code}" -X PATCH \
    "$BASE/orders/$ORD?key=$K&$2" -H "Content-Type: application/json" -d "$1"
}
MASK="updateMask.fieldPaths=status&updateMask.fieldPaths=driverId"
body() { echo "{\"fields\":{\"driverId\":$1,\"status\":{\"stringValue\":\"$2\"}}}"; }
NULLV='{"nullValue":null}'
sv() { echo "{\"stringValue\":\"$1\"}"; }

# Test buyurtmasi 'cancelled' holatida yaratiladi -> dispatch funksiyasi
# darhol chiqib ketadi, hech kimga push yuborilmaydi. branchId ham
# mavjud bo'lmagan filial, ya'ni hech kimning ro'yxatiga tushmaydi.
mk=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/orders?documentId=$ORD&key=$K" \
  -H "Content-Type: application/json" \
  -d '{"fields":{"status":{"stringValue":"cancelled"},"driverId":{"nullValue":null},"branchId":{"stringValue":"ZZTEST-BRANCH"},"customerName":{"stringValue":"CLAIM TEST"},"fromAddress":{"stringValue":"TEST"},"toAddress":{"stringValue":"TEST"},"price":{"integerValue":"0"}}}')
[ "$mk" = "200" ] || { echo "    XATO: test buyurtmasini yaratib bolmadi ($mk)"; exit 1; }
echo "    test buyurtmasi: $ORD"

echo "[1] Oddiy oqim buzilmaganmi (eski ilova ham ishlashi SHART)"
chk "pending ga otkazish" "$(patch "$(body "$NULLV" pending)" "$MASK")" allow
chk "A haydovchi oladi" "$(patch "$(body "$(sv +998900000001)" accepted)" "$MASK")" allow
chk "A safarni boshlaydi" "$(patch "$(body "$(sv +998900000001)" in_progress)" "$MASK")" allow
chk "A safarni yakunlaydi" "$(patch "$(body "$(sv +998900000001)" completed)" "$MASK")" allow

echo "[2] Ikkinchi haydovchi TORTIB ola oladimi"
chk "qayta pending + bosatish" "$(patch "$(body "$NULLV" pending)" "$MASK")" allow
chk "A oladi" "$(patch "$(body "$(sv +998900000001)" accepted)" "$MASK")" allow
chk "B TORTIB oladi" "$(patch "$(body "$(sv +998900000002)" accepted)" "$MASK")" deny

echo "[3] Bosatish yoli ochiq qolganmi (balansi yetmagan haydovchi)"
chk "driverId -> null" "$(patch "$(body "$NULLV" pending)" "$MASK")" allow
chk "bosatilgach B ola oladi" "$(patch "$(body "$(sv +998900000002)" accepted)" "$MASK")" allow

curl -s -o /dev/null -X PATCH "$BASE/orders/$ORD?key=$K&updateMask.fieldPaths=status" \
  -H "Content-Type: application/json" -d '{"fields":{"status":{"stringValue":"cancelled"}}}'

echo
echo "Tozalash kerak: orders/$ORD"
[ $fails -eq 0 ] && echo "HAMMASI PASS" || echo "$fails ta FAIL"
exit $fails
