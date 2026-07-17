#!/bin/bash
# Clear persisted order, log, and market adapter files in one operation.
#
# This combines the behavior of clear-orders.sh, clear-logs.sh, and
# clear-market-adapter.sh while using a single confirmation prompt.
# Usage: ./scripts/clear-all.sh or bash scripts/clear-all.sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PROFILE_ROOT="${DEXBOT_PROFILE_ROOT:-${PROJECT_ROOT}/profiles}"
ORDERS_DIR="${PROFILE_ROOT}/orders"
LOGS_DIR="${PROFILE_ROOT}/logs"
MA_DATA_DIR="${PROJECT_ROOT}/market_adapter/data"
MA_STATE_DIR="${PROJECT_ROOT}/market_adapter/state"

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_info "=========================================="
log_info "DEXBot2 Clear All Script"
log_info "=========================================="
log_info "Orders directory:              $ORDERS_DIR"
log_info "Logs directory:                $LOGS_DIR"
log_info "Market adapter data directory: $MA_DATA_DIR"
log_info "Market adapter state directory: $MA_STATE_DIR"
log_info ""
log_warning "WARNING: This will delete all persisted order, log, and market adapter files!"
log_warning "Bots will regenerate grids and market adapter will re-bootstrap from Kibana."
log_info ""

# Check directories and count files
ORDER_COUNT=0
LOG_COUNT=0
MA_DATA_COUNT=0
MA_STATE_COUNT=0

if [ -d "$ORDERS_DIR" ]; then
    ORDER_COUNT=$(find "$ORDERS_DIR" -type f 2>/dev/null | wc -l)
else
    log_warning "Orders directory does not exist: $ORDERS_DIR"
fi

if [ -d "$LOGS_DIR" ]; then
    LOG_COUNT=$(find "$LOGS_DIR" -type f \( -name "*.log" -o -name "*.jsonl" \) 2>/dev/null | wc -l)
else
    log_warning "Logs directory does not exist: $LOGS_DIR"
fi

if [ -d "$MA_DATA_DIR" ]; then
    MA_DATA_COUNT=$(find "$MA_DATA_DIR" -type f 2>/dev/null | wc -l)
else
    log_warning "Market adapter data directory does not exist: $MA_DATA_DIR"
fi

if [ -d "$MA_STATE_DIR" ]; then
    MA_STATE_COUNT=$(find "$MA_STATE_DIR" -type f 2>/dev/null | wc -l)
else
    log_warning "Market adapter state directory does not exist: $MA_STATE_DIR"
fi

TOTAL_COUNT=$((ORDER_COUNT + LOG_COUNT + MA_DATA_COUNT + MA_STATE_COUNT))

if [ "$TOTAL_COUNT" -eq 0 ]; then
    log_info "No matching files found to delete."
    exit 0
fi

log_info "Found $ORDER_COUNT order, $LOG_COUNT log, $MA_DATA_COUNT data, and $MA_STATE_COUNT state file(s) to delete"
log_info ""

# Show what will be deleted
if [ "$ORDER_COUNT" -gt 0 ]; then
    log_info "Order files to be deleted:"
    find "$ORDERS_DIR" -type f 2>/dev/null | while read -r file; do
        SIZE=$(du -h "$file" | cut -f1)
        echo -e "${BLUE}  -${NC} $(realpath --relative-to="$PROJECT_ROOT" "$file") ($SIZE)"
    done
    log_info ""
fi

if [ "$LOG_COUNT" -gt 0 ]; then
    log_info "Log files to be deleted:"
    find "$LOGS_DIR" -type f \( -name "*.log" -o -name "*.jsonl" \) 2>/dev/null | while read -r file; do
        SIZE=$(du -h "$file" | cut -f1)
        echo -e "${BLUE}  -${NC} $(realpath --relative-to="$PROJECT_ROOT" "$file") ($SIZE)"
    done
    log_info ""
fi

if [ "$MA_DATA_COUNT" -gt 0 ]; then
    log_info "Market adapter data files to be deleted:"
    find "$MA_DATA_DIR" -type f 2>/dev/null | while read -r file; do
        SIZE=$(du -h "$file" | cut -f1)
        echo -e "${BLUE}  -${NC} $(realpath --relative-to="$PROJECT_ROOT" "$file") ($SIZE)"
    done
    log_info ""
fi

if [ "$MA_STATE_COUNT" -gt 0 ]; then
    log_info "Market adapter state files to be deleted:"
    find "$MA_STATE_DIR" -type f 2>/dev/null | while read -r file; do
        SIZE=$(du -h "$file" | cut -f1)
        echo -e "${BLUE}  -${NC} $(realpath --relative-to="$PROJECT_ROOT" "$file") ($SIZE)"
    done
    log_info ""
fi

# Ask for confirmation
read -p "Delete all listed files? (y/n): " -r CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    log_warning "Cancelled"
    exit 0
fi

# Delete files
if [ "$ORDER_COUNT" -gt 0 ]; then
    find "$ORDERS_DIR" -type f 2>/dev/null -delete
fi

if [ "$LOG_COUNT" -gt 0 ]; then
    find "$LOGS_DIR" -type f \( -name "*.log" -o -name "*.jsonl" \) 2>/dev/null -delete
fi

if [ "$MA_DATA_COUNT" -gt 0 ]; then
    find "$MA_DATA_DIR" -type f 2>/dev/null -delete
    find "$MA_DATA_DIR" -type d -empty 2>/dev/null -delete
fi

if [ "$MA_STATE_COUNT" -gt 0 ]; then
    find "$MA_STATE_DIR" -type f 2>/dev/null -delete
fi

# Re-count to confirm
REMAINING_ORDERS=0
REMAINING_LOGS=0
REMAINING_MA_DATA=0
REMAINING_MA_STATE=0

if [ -d "$ORDERS_DIR" ]; then
    REMAINING_ORDERS=$(find "$ORDERS_DIR" -type f 2>/dev/null | wc -l)
fi

if [ -d "$LOGS_DIR" ]; then
    REMAINING_LOGS=$(find "$LOGS_DIR" -type f \( -name "*.log" -o -name "*.jsonl" \) 2>/dev/null | wc -l)
fi

if [ -d "$MA_DATA_DIR" ]; then
    REMAINING_MA_DATA=$(find "$MA_DATA_DIR" -type f 2>/dev/null | wc -l)
fi

if [ -d "$MA_STATE_DIR" ]; then
    REMAINING_MA_STATE=$(find "$MA_STATE_DIR" -type f 2>/dev/null | wc -l)
fi

log_info "=========================================="
if [ "$REMAINING_ORDERS" -eq 0 ] && [ "$REMAINING_LOGS" -eq 0 ] && [ "$REMAINING_MA_DATA" -eq 0 ] && [ "$REMAINING_MA_STATE" -eq 0 ]; then
    log_success "All files cleared!"
    log_info "Total deleted: $TOTAL_COUNT (orders: $ORDER_COUNT, logs: $LOG_COUNT, ma_data: $MA_DATA_COUNT, ma_state: $MA_STATE_COUNT)"
    log_info ""
    log_info "Next steps:"
    log_info "- Bots will regenerate their grids on next run"
    log_info "- Market adapter will re-bootstrap candle data from Kibana on next run"
    log_info "- Start bots normally: pm2 start all (or specific bot name)"
    log_info "- Monitor startup with: pm2 logs"
else
    log_warning "Cleanup incomplete — remaining: orders=$REMAINING_ORDERS logs=$REMAINING_LOGS ma_data=$REMAINING_MA_DATA ma_state=$REMAINING_MA_STATE"
fi
log_info "=========================================="

exit 0
