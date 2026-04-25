#!/bin/bash
set -e

cd "$(dirname "$0")"
rm -rf store-a store-b

echo "=== Starting bootstrap DHT ==="
node boot.js > /tmp/boot.log 2>&1 &
BOOT_PID=$!
sleep 2
BOOT_PORT=$(grep "port" /tmp/boot.log | grep -o '[0-9]*')
echo "Bootstrap on port $BOOT_PORT (PID $BOOT_PID)"
export BOOTSTRAP="localhost:$BOOT_PORT"

echo ""
echo "=== Starting Peer A ==="
BOOTSTRAP=$BOOTSTRAP node peer-a.js > /tmp/peer-a.log 2>&1 &
PEER_A_PID=$!
sleep 2
AUTOBASE_KEY=$(grep "Autobase key:" /tmp/peer-a.log | awk '{print $3}')
WRITER_A_KEY=$(grep "Writer key:" /tmp/peer-a.log | awk '{print $3}')
echo "Peer A PID: $PEER_A_PID"
echo "Autobase key: $AUTOBASE_KEY"

echo ""
echo "=== Starting Peer B ==="
BOOTSTRAP=$BOOTSTRAP node peer-b.js "$AUTOBASE_KEY" > /tmp/peer-b.log 2>&1 &
PEER_B_PID=$!
sleep 3
WRITER_B_KEY=$(grep "Writer key:" /tmp/peer-b.log | awk '{print $3}')
echo "Peer B PID: $PEER_B_PID"
echo "Writer B key: $WRITER_B_KEY"

echo ""
echo "=== Waiting for connection ==="
sleep 5

echo ""
echo "=== Peer A: adding Peer B as writer ==="
echo "add $WRITER_B_KEY" > /proc/$PEER_A_PID/fd/0 2>/dev/null || echo "add $WRITER_B_KEY" | kill -0 $PEER_A_PID 2>/dev/null
# Use a different approach for macOS
sleep 3

echo ""
echo "=== Peer A log ==="
cat /tmp/peer-a.log
echo ""
echo "=== Peer B log ==="
cat /tmp/peer-b.log

kill $PEER_A_PID $PEER_B_PID $BOOT_PID 2>/dev/null
wait 2>/dev/null
echo ""
echo "=== Done ==="
