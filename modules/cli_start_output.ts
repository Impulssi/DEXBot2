import { CLI_COLORS } from './cli_colors.js';

/** Format a launcher notice consistently for TTY and non-TTY output. */
export function formatStartupNotice(text: string, { isTTY = false, noColor = false }: { isTTY?: boolean; noColor?: boolean } = {}): string {
    return isTTY && !noColor
        ? `${CLI_COLORS.yellowBold}${text}${CLI_COLORS.reset}`
        : text;
}
