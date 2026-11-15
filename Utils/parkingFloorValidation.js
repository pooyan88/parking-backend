function validateParkingFloor(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { error: 'Provide floor_number and an optional label in a JSON object' };
    }
    if (Object.keys(body).some(key => !['floor_number', 'label'].includes(key))) {
        return { error: 'Only floor_number and label can be provided' };
    }
    const { floor_number: floorNumber, label } = body;
    if (!Number.isInteger(floorNumber) || floorNumber < -2147483648 || floorNumber > 2147483647) {
        return { error: 'Floor number must be an integer between -2147483648 and 2147483647' };
    }
    if (label !== undefined && label !== null && (
        typeof label !== 'string' || !label.trim() || [...label.trim()].length > 255 || label.includes('\0')
    )) {
        return { error: 'Label must be null or non-empty text up to 255 characters, without null characters' };
    }
    return { floorNumber, label: label == null ? null : label.trim() };
}

module.exports = { validateParkingFloor };
