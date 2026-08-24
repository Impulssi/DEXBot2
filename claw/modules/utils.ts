function clone(value: any) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function requirePositiveNumber(value: any, fieldName: string) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }
  return numericValue;
}

export { clone, requirePositiveNumber }

