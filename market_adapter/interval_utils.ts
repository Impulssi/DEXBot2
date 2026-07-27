'use strict';

function toIntervalLabel(intervalSeconds: any) {
    if (intervalSeconds % 86400 === 0) return `${intervalSeconds / 86400}d`;
    if (intervalSeconds % 3600 === 0) return `${intervalSeconds / 3600}h`;
    if (intervalSeconds % 60 === 0) return `${intervalSeconds / 60}m`;
    return `${intervalSeconds}s`;
}

export { toIntervalLabel }

