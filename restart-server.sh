#!/bin/bash

# Kill any existing server on port 3200
echo "Stopping existing server..."
pkill -f "node server.js" 2>/dev/null || true

# Wait a moment
sleep 2

# Start the server
echo "Starting server..."
cd "$(dirname "$0")"
node server.js &

# Wait for server to start
sleep 3

# Test the server
echo "Testing server..."
curl -s -o /dev/null -w "HTTP Status: %{http_code}\n" http://localhost:3200/

echo "Server should be running at http://localhost:3200/"