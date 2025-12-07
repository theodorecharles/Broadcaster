#!/bin/bash

BASE_URL="https://tv.tedcharles.net"
EXTENDED=false
CONTINUOUS=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --extended)
            EXTENDED=true
            shift
            ;;
        --continuous)
            CONTINUOUS=true
            shift
            ;;
        *)
            shift
            ;;
    esac
done

# Get timestamp in same format as docker logs
timestamp() {
    date -u +"%a, %d %b %Y %H:%M:%S GMT"
}

run_benchmark() {

echo "Fetching manifest..."
req_time=$(timestamp)
manifest=$(curl -s -w "\n%{time_total}\n%{size_download}" "$BASE_URL/manifest.json")
manifest_time=$(echo "$manifest" | tail -2 | head -1)
manifest_size=$(echo "$manifest" | tail -1)
manifest_time_ms=$(echo "$manifest_time * 1000" | bc | xargs printf "%.0f")
manifest_size_kb=$(echo "scale=2; $manifest_size / 1024" | bc)
manifest=$(echo "$manifest" | sed -n '1,/^[0-9]*\.[0-9]*$/{ /^[0-9]*\.[0-9]*$/!p }')

if [ -z "$manifest" ]; then
    echo "Error: Failed to fetch manifest"
    exit 1
fi

echo ""
printf "%-30s %-25s %10s %10s\n" "Timestamp" "Endpoint" "Time (ms)" "Size (KB)"
printf "%-30s %-25s %10s %10s\n" "---------" "--------" "---------" "---------"
printf "%-30s %-25s %10s %10s\n" "$req_time" "manifest.json" "$manifest_time_ms" "$manifest_size_kb"

# Extract slugs and benchmark each
echo "$manifest" | jq -r '.channels[].slug' | while read -r slug; do
    req_time=$(timestamp)
    if [ "$EXTENDED" = true ]; then
        # Fetch playlist content along with timing
        playlist=$(curl -s -w "\n%{time_total} %{size_download}" "$BASE_URL/$slug.m3u8")
        stats=$(echo "$playlist" | tail -1)
        time_s=$(echo "$stats" | awk '{print $1}')
        size_bytes=$(echo "$stats" | awk '{print $2}')
        playlist_content=$(echo "$playlist" | sed '$d')
    else
        # Just get timing info
        result=$(curl -s -o /dev/null -w "%{time_total} %{size_download}" "$BASE_URL/$slug.m3u8")
        time_s=$(echo "$result" | awk '{print $1}')
        size_bytes=$(echo "$result" | awk '{print $2}')
    fi

    time_ms=$(echo "$time_s * 1000" | bc | xargs printf "%.0f")
    size_kb=$(echo "scale=2; $size_bytes / 1024" | bc)
    printf "%-30s %-25s %10s %10s\n" "$req_time" "$slug.m3u8" "$time_ms" "$size_kb"

    if [ "$EXTENDED" = true ]; then
        # Get first segment URL (first non-comment line)
        first_segment=$(echo "$playlist_content" | grep -v '^#' | head -1)

        if [ -n "$first_segment" ]; then
            # Handle relative vs absolute URLs
            if [[ "$first_segment" == http* ]]; then
                segment_url="$first_segment"
            else
                segment_url="$BASE_URL/$first_segment"
            fi

            seg_req_time=$(timestamp)
            seg_result=$(curl -s -o /dev/null -w "%{time_total} %{size_download}" "$segment_url")
            seg_time_s=$(echo "$seg_result" | awk '{print $1}')
            seg_size_bytes=$(echo "$seg_result" | awk '{print $2}')
            seg_time_ms=$(echo "$seg_time_s * 1000" | bc | xargs printf "%.0f")
            seg_size_kb=$(echo "scale=2; $seg_size_bytes / 1024" | bc)

            printf "%-30s   └─ %-20s %10s %10s\n" "$seg_req_time" "segment" "$seg_time_ms" "$seg_size_kb"
        fi
    fi
done

echo ""
echo "Benchmark complete."
}

# Main execution
if [ "$CONTINUOUS" = true ]; then
    trap 'echo -e "\nStopped."; exit 0' INT
    run_count=0
    while true; do
        ((run_count++))
        echo "=== Run #$run_count @ $(timestamp) ==="
        run_benchmark
        echo ""
        sleep 1
    done
else
    echo "=== Benchmark @ $(timestamp) ==="
    run_benchmark
fi
