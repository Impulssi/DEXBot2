#!/bin/bash
# Clear market adapter data, state files, and runtime log.
#
# Removes all persisted candle data and state files from market_adapter/data/
# and market_adapter/state/, plus profiles/logs/market_adapter.log,
# dexbot-adapter.log, and dexbot-adapter-error.log. The market
# adapter will bootstrap fresh from Kibana and regenerate state on next run.
#
# Usage: ./scripts/clear-market-adapter.sh or bash scripts/clear-market-adapter.sh

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
source "$SCRIPT_DIR/lib/dexbot-paths.sh"
DATA_DIR="$MA_DATA_DIR"
STATE_DIR="$MA_STATE_DIR"
MARKET_ADAPTER_LOG="${PROFILE_ROOT}/logs/market_adapter.log"
ADAPTER_OUT_LOG="${PROFILE_ROOT}/logs/dexbot-adapter.log"
ADAPTER_ERR_LOG="${PROFILE_ROOT}/logs/dexbot-adapter-error.log"

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
log_info "DEXBot2 Clear Market Adapter Script"
log_info "=========================================="
log_info "Data directory:  $DATA_DIR"
log_info "State directory: $STATE_DIR"
log_info "Log file:        $MARKET_ADAPTER_LOG"
log_info "Adapter out log: $ADAPTER_OUT_LOG"
log_info "Adapter err log: $ADAPTER_ERR_LOG"
log_info ""
log_warning "WARNING: This will delete all persisted candle data and state files!"
log_warning "This also deletes the market adapter runtime log."
log_warning "The market adapter will bootstrap fresh from Kibana on next run."
log_info ""

# Count files
DATA_COUNT=0
STATE_COUNT=0
LOG_COUNT=0

if [ -d "$DATA_DIR" ]; then
    DATA_COUNT=$(find "$DATA_DIR" -type f 2>/dev/null | wc -l)
else
    log_warning "Data directory does not exist: $DATA_DIR"
fi

if [ -d "$STATE_DIR" ]; then
    STATE_COUNT=$(find "$STATE_DIR" -type f 2>/dev/null | wc -l)
else
    log_warning "State directory does not exist: $STATE_DIR"
fi

if [ -f "$MARKET_ADAPTER_LOG" ]; then
    LOG_COUNT=$((LOG_COUNT + 1))
fi

if [ -f "$ADAPTER_OUT_LOG" ]; then
    LOG_COUNT=$((LOG_COUNT + 1))
fi

if [ -f "$ADAPTER_ERR_LOG" ]; then
    LOG_COUNT=$((LOG_COUNT + 1))
fi

TOTAL_COUNT=$((DATA_COUNT + STATE_COUNT + LOG_COUNT))

if [ "$TOTAL_COUNT" -eq 0 ]; then
    log_info "No files found to delete."
    exit 0
fi

log_info "Found $DATA_COUNT data file(s), $STATE_COUNT state file(s), and $LOG_COUNT log file(s) to delete"
log_info ""

# Show what will be deleted
if [ "$DATA_COUNT" -gt 0 ]; then
    log_info "Data files to be deleted:"
    find "$DATA_DIR" -type f 2>/dev/null | while read -r file; do
        SIZE=$(du -h "$file" | cut -f1)
        echo -e "${BLUE}  -${NC} $(realpath --relative-to="$PROJECT_ROOT" "$file") ($SIZE)"
    done
    log_info ""
fi

if [ "$STATE_COUNT" -gt 0 ]; then
    log_info "State files to be deleted:"
    find "$STATE_DIR" -type f 2>/dev/null | while read -r file; do
        SIZE=$(du -h "$file" | cut -f1)
        echo -e "${BLUE}  -${NC} $(realpath --relative-to="$PROJECT_ROOT" "$file") ($SIZE)"
    done
    log_info ""
fi

if [ "$LOG_COUNT" -gt 0 ]; then
    log_info "Log files to be deleted:"
    for logfile in "$MARKET_ADAPTER_LOG" "$ADAPTER_OUT_LOG" "$ADAPTER_ERR_LOG"; do
        if [ -f "$logfile" ]; then
            SIZE=$(du -h "$logfile" | cut -f1)
            echo -e "${BLUE}  -${NC} $(realpath --relative-to="$PROJECT_ROOT" "$logfile") ($SIZE)"
        fi
    done
    log_info ""
fi

# Ask for confirmation
read -p "Delete all listed market adapter files? (y/n): " -r CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    log_warning "Cancelled"
    exit 0
fi

# Delete data files
if [ "$DATA_COUNT" -gt 0 ]; then
    log_info "Deleting data files..."
    find "$DATA_DIR" -type f 2>/dev/null -delete
    # Clean up empty subdirectories
    find "$DATA_DIR" -type d -empty 2>/dev/null -delete
fi

# Delete state files
if [ "$STATE_COUNT" -gt 0 ]; then
    log_info "Deleting state files..."
    find "$STATE_DIR" -type f 2>/dev/null -delete
fi

if [ "$LOG_COUNT" -gt 0 ]; then
    log_info "Deleting market adapter logs..."
    rm -f "$MARKET_ADAPTER_LOG" "$ADAPTER_OUT_LOG" "$ADAPTER_ERR_LOG"
fi

# Re-count to confirm
REMAINING_DATA=0
REMAINING_STATE=0
REMAINING_LOG=0

if [ -d "$DATA_DIR" ]; then
    REMAINING_DATA=$(find "$DATA_DIR" -type f 2>/dev/null | wc -l)
fi

if [ -d "$STATE_DIR" ]; then
    REMAINING_STATE=$(find "$STATE_DIR" -type f 2>/dev/null | wc -l)
fi

if [ -f "$MARKET_ADAPTER_LOG" ]; then
    REMAINING_LOG=$((REMAINING_LOG + 1))
fi

if [ -f "$ADAPTER_OUT_LOG" ]; then
    REMAINING_LOG=$((REMAINING_LOG + 1))
fi

if [ -f "$ADAPTER_ERR_LOG" ]; then
    REMAINING_LOG=$((REMAINING_LOG + 1))
fi

log_info "=========================================="
if [ "$REMAINING_DATA" -eq 0 ] && [ "$REMAINING_STATE" -eq 0 ] && [ "$REMAINING_LOG" -eq 0 ]; then
    log_success "All market adapter files cleared!"
    log_info "Total deleted: $TOTAL_COUNT (data: $DATA_COUNT, state: $STATE_COUNT, log: $LOG_COUNT)"
    log_info ""
    log_info "Next steps:"
    log_info "- The market adapter will bootstrap fresh candle data from Kibana on next run"
    log_info "- All bot center prices and AMA state will be recomputed"
    log_info "- Start market adapter: tsx market_adapter/market_adapter.ts"
else
    log_warning "Cleanup incomplete. Remaining data files: $REMAINING_DATA, remaining state files: $REMAINING_STATE, remaining logs: $REMAINING_LOG"
fi
log_info "=========================================="

exit 0
