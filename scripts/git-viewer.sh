#!/bin/bash
# Git Viewer - Interactive tool for monitoring and navigating git changes
# This script provides a comprehensive view of uncommitted, committed, and pushed changes
# with an interactive menu system and fzf-based search/preview capabilities.

################################################################################
# DEPENDENCY CHECK SECTION
################################################################################

# check_dependencies: Verify and install required system tools
# Required packages:
#   - delta: Enhanced diff viewer with syntax highlighting
#   - fzf: Fuzzy finder for interactive selection
#   - bat/batcat: Syntax-highlighted file viewer
# This function checks each dependency and installs missing packages
# using the appropriate package manager for the current OS.
check_dependencies() {
    local missing_packages=()

    # Check for delta - used for colorized diff output
    if ! command -v delta &> /dev/null; then
        missing_packages+=("git-delta")
    fi

    # Check for fzf - used for interactive file/commit selection
    if ! command -v fzf &> /dev/null; then
        missing_packages+=("fzf")
    fi

    # Check for batcat (Ubuntu) or bat (other distros) - used for file syntax highlighting
    if ! command -v batcat &> /dev/null && ! command -v bat &> /dev/null; then
        missing_packages+=("bat")
    fi

    # Install missing packages if any were found
    if [ ${#missing_packages[@]} -gt 0 ]; then
        echo "Installing missing dependencies: ${missing_packages[@]}"

        if command -v apt-get &> /dev/null; then
            sudo apt-get update -qq
            sudo apt-get install -y -qq "${missing_packages[@]}"
        elif command -v brew &> /dev/null; then
            brew install "${missing_packages[@]}"
        elif command -v dnf &> /dev/null; then
            sudo dnf install -y "${missing_packages[@]}"
        elif command -v pacman &> /dev/null; then
            sudo pacman -S --noconfirm "${missing_packages[@]}"
        else
            echo "Warning: Could not detect package manager. Please install manually: ${missing_packages[@]}"
            echo "  apt-get: sudo apt-get install ${missing_packages[*]}"
            echo "  brew:    brew install ${missing_packages[*]}"
            return 0
        fi

        echo "Dependencies installed successfully!"
        sleep 1
    fi
}

# Run dependency check on script startup
check_dependencies

################################################################################
# TERMINAL & CLEANUP SECTION
################################################################################

# clear_screen: ANSI escape sequence to clear terminal and move cursor to home position
# Uses: ESC[2J (clear screen) + ESC[H (move cursor to 0,0)
clear_screen() {
    printf "\033[2J\033[H"
}

# cleanup: Graceful exit handler called when user presses Ctrl+C or terminates script
# Resets terminal to normal mode and exits with status 0
cleanup() {
    clear_screen
    # Reset terminal to normal mode (in case any special terminal modes were enabled)
    stty sane 2>/dev/null || true
    echo "Exiting..."
    exit 0
}

# Set up signal handlers for graceful shutdown on interrupt or termination signals
trap cleanup INT TERM

################################################################################
# MENU & DISPLAY SECTION
################################################################################

# show_menu: Display main navigation menu with available options
# Options:
#   [1] View all changes - Show complete git status across all change categories
#   [2] Search uncommitted - Interactive search through staged/unstaged/untracked files
#   [3] Search committed - Interactive search through unpushed commits
#   [4] Search pushed - Interactive search through remote commits
#   [q] Quit - Exit the application
show_menu() {
    echo ""
    echo "═══════════════════════════════════════════════════════"
    echo "CONTROLS:"
    echo "  [1] View all changes       [2] Search uncommitted"
    echo "  [3] Search committed       [4] Search pushed"
    echo "  [q] Quit"
    echo "═══════════════════════════════════════════════════════"
}

# show_all_changes: Display comprehensive view of all git changes in three categories
# Categories displayed:
#   1. UNCOMMITTED: Changes not yet committed (staged, unstaged, untracked)
#   2. COMMITTED: Local commits not yet pushed to remote
#   3. PUSHED: Latest commits on the remote branch
# Uses delta for enhanced diff output and displays timestamp of last update
show_all_changes() {
    clear_screen
    echo "=== Complete Git Changes Monitor ==="
    echo "Last update: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "=================================================="
    echo ""

    # Get current branch and derive remote branch name
    current_branch=$(git rev-parse --abbrev-ref HEAD)
    remote_branch="origin/$current_branch"
    echo "Current branch: $current_branch | Remote: $remote_branch"
    echo ""

    # Section 1: Display uncommitted changes (staged, unstaged, untracked)
    echo "========== 1. UNCOMMITTED (All changes not yet committed) =========="
    echo "--- Staged changes ---"
    git diff --staged | delta || echo "No staged changes"
    echo ""
    echo "--- Unstaged changes ---"
    git diff | delta || echo "No unstaged changes"
    echo ""
    echo "--- Untracked files ---"
    git ls-files --others --exclude-standard || echo "No untracked files"

    echo ""
    # Section 2: Display commits that exist locally but haven't been pushed to remote
    echo "========== 2. COMMITTED (Local commits not yet pushed) =========="
    echo "Commits:"
    git log origin/$(git rev-parse --abbrev-ref HEAD)..HEAD --oneline 2>/dev/null || echo "No committed unpushed changes"
    echo ""
    echo "Diff:"
    git diff origin/$(git rev-parse --abbrev-ref HEAD)..HEAD 2>/dev/null | delta || echo "No diff in unpushed commits"

    echo ""
    # Section 3: Display latest commits from the remote branch
    echo "========== 3. PUSHED (On remote branch) =========="
    echo "Latest pushed commits:"
    git log origin/$(git rev-parse --abbrev-ref HEAD) --oneline -10 2>/dev/null || echo "Remote branch not found"

    show_menu
}

################################################################################
# SEARCH UNCOMMITTED SECTION
################################################################################

# search_uncommitted: Interactive search and preview of uncommitted changes
# Displays:
#   - Staged files
#   - Unstaged files
#   - Untracked files
# Uses fzf for fuzzy file selection with live preview via batcat/bat
# After selecting a file, user can toggle between:
#   [f] Full file view - Show entire file with syntax highlighting
#   [d] Diff view - Show only changes made to the file
#   [q] Back - Return to file selection
#   [b] Main menu - Return to main menu
search_uncommitted() {
    clear_screen
    echo "╔═══════════════════════════════════════════════════════╗"
    echo "║  SEARCH MODE - Type to filter files"
    echo "║  UP/DOWN arrows select | ENTER opens file | ESC back"
    echo "╚═══════════════════════════════════════════════════════╝"
    echo ""

    # Gather all uncommitted files from three sources
    staged=$(git diff --staged --name-only)
    unstaged=$(git diff --name-only)
    untracked=$(git ls-files --others --exclude-standard)
    # Combine all file lists, remove empty lines, and deduplicate
    files=$(echo -e "$staged\n$unstaged\n$untracked" | grep -v "^$" | sort -u)

    # Handle case where no uncommitted files exist
    if [ -z "$files" ]; then
        echo "No uncommitted files"
        sleep 2
        show_all_changes
        return
    fi

    # Loop to handle multiple file selections before returning to main menu
    while true; do
        # Use fzf to select file with preview window showing first 100 lines
        # --preview uses batcat or fallback to head for file preview
        # --preview-window=right:67% shows preview on right side with 67% width
        # --bind 'esc:abort' allows ESC to exit fzf without selection
        selected=$(echo "$files" | fzf --ansi --preview 'batcat --color=always --line-range :100 {} 2>/dev/null || head -100 {}' --preview-window=right:67% --bind 'esc:abort')

        # If user pressed ESC, return to main menu
        if [ -z "$selected" ]; then
            show_all_changes
            return
        fi

        # File was selected - enter file viewing mode
        if [ -n "$selected" ]; then
            view_mode="full"  # Start in full file view mode
            # Loop to allow user to toggle between full/diff views for same file
            while true; do
                clear_screen
                echo "╔═══════════════════════════════════════════════════════╗"
                echo "║  VIEWING: $selected"
                echo "║  Display: $([ "$view_mode" = "diff" ] && echo "DIFF ONLY" || echo "FULL FILE")"
                echo "╚═══════════════════════════════════════════════════════╝"
                echo ""
                echo "⚠️  DO NOT TYPE - Use SINGLE KEYS only:"
                echo "   [f]=Full  [d]=Diff  [q]=Back to search  [b]=Main menu"
                echo ""
                echo "────────────────────────────────────────────────────────"
                echo ""

                # Display either diff or full file content based on current view mode
                if [ "$view_mode" = "diff" ]; then
                    # Check if file is tracked in git
                    if git ls-files --error-unmatch "$selected" 2>/dev/null; then
                        # File is tracked - show diff of changes
                        git diff --color=always "$selected" 2>/dev/null | delta || echo "No changes in this file"
                    else
                        # File is untracked (new) - cannot show diff
                        echo "File is untracked (new file) - no diff to show"
                    fi
                else
                    # Full file view mode - show entire file with syntax highlighting
                    batcat --color=always "$selected" 2>/dev/null || cat "$selected"
                fi

                echo ""
                echo "════════════════════════════════════════════════════════"
                # Read single keystroke without requiring Enter (non-blocking read)
                read -n 1 -s key

                # Handle user input
                case $key in
                    f) view_mode="full" ;;      # Switch to full file view
                    d) view_mode="diff" ;;      # Switch to diff view
                    q) break ;;                 # Return to file selection
                    b) show_all_changes; return ;; # Return to main menu
                esac
            done
        fi
    done
}

################################################################################
# SEARCH COMMITTED SECTION
################################################################################

# search_committed: Interactive search and view of unpushed local commits
# Displays commits that exist locally but have not been pushed to the remote branch
# Uses fzf with commit preview to show commit details
# Allows user to view full commit diff with syntax highlighting
search_committed() {
    current_branch=$(git rev-parse --abbrev-ref HEAD)
    remote_branch="origin/$current_branch"

    clear_screen
    echo "╔═══════════════════════════════════════════════════════╗"
    echo "║  SEARCH COMMITTED (UNPUSHED)                          ║"
    echo "║  Use arrows to navigate | Enter to view full | Esc to back"
    echo "╚═══════════════════════════════════════════════════════╝"
    echo ""

    # Get all commits that exist on local branch but not on remote
    commits=$(git log $remote_branch..HEAD --oneline 2>/dev/null)

    # Handle case where no unpushed commits exist
    if [ -z "$commits" ]; then
        echo "No unpushed commits"
        sleep 2
        show_all_changes
        return
    fi

    # Loop to allow searching multiple commits
    while true; do
        # Use fzf to select commit with preview showing commit details
        # Preview extracts commit hash from first field and shows git show output
        selected=$(echo "$commits" | fzf --ansi --preview 'commit_hash=$(echo {} | awk "{print \$1}"); git show --color=always $commit_hash | head -100' --preview-window=right:67% --bind 'esc:abort')

        # If user pressed ESC, return to main menu
        if [ -z "$selected" ]; then
            show_all_changes
            return
        fi

        # Commit was selected - show full commit details
        if [ -n "$selected" ]; then
            # Extract commit hash from first field of selected line
            commit_hash=$(echo "$selected" | awk '{print $1}')

            clear_screen
            echo "╔═══════════════════════════════════════════════════════╗"
            echo "║  COMMIT: $commit_hash"
            echo "║  Press [q] to go back, [b] to back to main menu"
            echo "╚═══════════════════════════════════════════════════════╝"
            echo ""
            # Display full commit details with enhanced diff via delta
            git show --color=always "$commit_hash" | delta

            echo ""
            echo "════════════════════════════════════════════════════════"
            # Prompt for next action
            read -n 1 -p "Press [q] to search again, [b] for main menu: " key

            # Return to main menu if requested
            if [ "$key" = "b" ]; then
                show_all_changes
                return
            fi
        fi
    done
}

################################################################################
# SEARCH PUSHED SECTION
################################################################################

# search_pushed: Interactive search and view of pushed remote commits
# Displays latest 100 commits from the remote branch
# Uses fzf with commit preview to show commit details
# Similar to search_committed but operates on remote branch history
search_pushed() {
    current_branch=$(git rev-parse --abbrev-ref HEAD)
    remote_branch="origin/$current_branch"

    clear_screen
    echo "╔═══════════════════════════════════════════════════════╗"
    echo "║  SEARCH PUSHED COMMITS (Latest 100)                   ║"
    echo "║  Use arrows to navigate | Enter to view full | Esc to back"
    echo "╚═══════════════════════════════════════════════════════╝"
    echo ""

    # Get latest 100 commits from remote branch
    commits=$(git log $remote_branch --oneline -100 2>/dev/null)

    # Handle case where no remote commits exist
    if [ -z "$commits" ]; then
        echo "No pushed commits found"
        sleep 2
        show_all_changes
        return
    fi

    # Loop to allow searching multiple commits
    while true; do
        # Use fzf to select commit with preview showing commit details
        selected=$(echo "$commits" | fzf --ansi --preview 'commit_hash=$(echo {} | awk "{print \$1}"); git show --color=always $commit_hash | head -100' --preview-window=right:67% --bind 'esc:abort')

        # If user pressed ESC, return to main menu
        if [ -z "$selected" ]; then
            show_all_changes
            return
        fi

        # Commit was selected - show full commit details
        if [ -n "$selected" ]; then
            # Extract commit hash from first field of selected line
            commit_hash=$(echo "$selected" | awk '{print $1}')

            clear_screen
            echo "╔═══════════════════════════════════════════════════════╗"
            echo "║  PUSHED COMMIT: $commit_hash"
            echo "║  Press [q] to go back, [b] to back to main menu"
            echo "╚═══════════════════════════════════════════════════════╝"
            echo ""
            # Display full commit details with enhanced diff via delta
            git show --color=always "$commit_hash" | delta

            echo ""
            echo "════════════════════════════════════════════════════════"
            # Prompt for next action
            read -n 1 -p "Press [q] to search again, [b] for main menu: " key

            # Return to main menu if requested
            if [ "$key" = "b" ]; then
                show_all_changes
                return
            fi
        fi
    done
}

################################################################################
# STATE DETECTION & AUTO-REFRESH SECTION
################################################################################

# get_local_state: Capture state of local working directory for change detection
# Returns a string representation of:
#   - Staged changes statistics
#   - Unstaged changes statistics
#   - Untracked files list
# Used to detect if working directory has changed since last check
get_local_state() {
    local state=""
    state+="$(git diff --staged --stat 2>/dev/null)|||"
    state+="$(git diff --stat 2>/dev/null)|||"
    state+="$(git ls-files --others --exclude-standard 2>/dev/null)"
    echo "$state"
}

# get_remote_state: Capture state of remote commits for change detection
# Returns a string representation of:
#   - Unpushed commits (commits local but not on remote)
#   - Latest 10 remote commits (to detect new pushed commits)
# Used to detect if remote branch has changed since last check
get_remote_state() {
    current_branch=$(git rev-parse --abbrev-ref HEAD)
    remote_branch="origin/$current_branch"

    local state=""
    state+="$(git log $remote_branch..HEAD --oneline 2>/dev/null)|||"
    state+="$(git log $remote_branch --oneline -10 2>/dev/null)"
    echo "$state"
}

################################################################################
# MAIN LOOP - INTERACTIVE MODE
################################################################################

# Display initial git status on script startup
show_all_changes

# Initialize state caches for detecting changes
previous_local_state=$(get_local_state)
previous_remote_state=$(get_remote_state)
last_update_time=$(date +%s)
last_remote_update_time=$(date +%s)

# Main event loop: monitor for user input and auto-refresh on changes
# Polling intervals:
#   - Local changes: checked every 1 second
#   - Remote changes: checked every 15 seconds (slower to reduce network traffic)
# User input: read with 1 second timeout to balance responsiveness and CPU usage
while true; do
    current_time=$(date +%s)

    # Check for keypress with 1 second timeout
    # read -t 1 waits up to 1 second for input
    # read -n 1 reads a single character
    # Exit code 0 means key was pressed, non-zero means timeout
    read -t 1 -n 1 action

    if [ $? -eq 0 ]; then
        # Key was pressed - handle menu navigation
        case $action in
            1) show_all_changes ;;      # Show all changes overview
            2) search_uncommitted ;;    # Search uncommitted files
            3) search_committed ;;      # Search unpushed commits
            4) search_pushed ;;         # Search remote commits
            q) cleanup ;;               # Quit application
        esac
    else
        # No key pressed - check for changes in working directory or remote
        local_state=$(get_local_state)

        # Check local changes every 1 second
        if [ $((current_time - last_update_time)) -ge 1 ]; then
            # If working directory state has changed, refresh display
            if [ "$local_state" != "$previous_local_state" ]; then
                show_all_changes
                previous_local_state="$local_state"
            fi
            last_update_time=$current_time
        fi

        # Check remote changes every 15 seconds (less frequent to save resources)
        if [ $((current_time - last_remote_update_time)) -ge 15 ]; then
            remote_state=$(get_remote_state)
            # If remote branch state has changed, refresh display
            if [ "$remote_state" != "$previous_remote_state" ]; then
                show_all_changes
                previous_remote_state="$remote_state"
            fi
            last_remote_update_time=$current_time
        fi
    fi
done
