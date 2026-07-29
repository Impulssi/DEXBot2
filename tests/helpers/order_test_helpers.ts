/**
 * Verify that every entry in a manager's orders Map is structurally sound
 * (non-null, has state and type).  Replaces the removed validateIndices().
 */
export function assertOrdersStructurallySound(manager: any): void {
    for (const [id, order] of manager.orders) {
        if (!order) throw new Error(`Index corruption: ${id} exists in orders Map but is null/undefined`);
        if (!order.state) throw new Error(`Index corruption: ${id} has no state`);
        if (!order.type) throw new Error(`Index corruption: ${id} has no type`);
    }
}
