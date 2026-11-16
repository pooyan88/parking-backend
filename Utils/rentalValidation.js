const { HttpError } = require('./httpErrors');
const input = require('./input');

function timestamp(value, name) {
    const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
    if (!match) throw new HttpError(400, `${name} must be ISO 8601 with seconds and an explicit offset`);
    const [, ys, ms, ds, hs, mins, ss, , zone, , oh, om] = match;
    const [year, month, day, hour, minute, second] = [ys, ms, ds, hs, mins, ss].map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59 ||
        (zone !== 'Z' && (Number(oh) > 14 || Number(om) > 59 || (Number(oh) === 14 && Number(om) !== 0)))) {
        throw new HttpError(400, `Invalid ${name}`);
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) throw new HttpError(400, `Invalid ${name}`);
    return date;
}
function timezone(value) {
    if (typeof value !== 'string' || value.length > 100 || !/^(?:UTC|GMT|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(value)) {
        throw new HttpError(400, 'Use an IANA timezone such as Asia/Tehran or UTC');
    }
    try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { throw new HttpError(400, 'Invalid timezone'); }
    return value;
}
function price(body, fallback = { agreed_price: null, currency: null }) {
    const supplied = Object.hasOwn(body, 'agreed_price') || Object.hasOwn(body, 'currency');
    if (!supplied) return { agreedPrice: fallback.agreed_price, currency: fallback.currency };
    if (body.agreed_price === null && body.currency === null) return { agreedPrice: null, currency: null };
    if (typeof body.agreed_price !== 'string' || !/^\d{1,16}(?:\.\d{1,2})?$/.test(body.agreed_price) ||
        typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) {
        throw new HttpError(400, 'Provide a non-negative decimal string price and a three-letter uppercase currency/unit code, or null for both');
    }
    return { agreedPrice: body.agreed_price, currency: body.currency };
}
function period(body, startsAt) {
    const type = body.rental_type;
    if (!['hourly', 'monthly', 'quarterly', 'custom'].includes(type)) throw new HttpError(400, 'Invalid rental_type');
    if (type === 'hourly') {
        if (!Number.isInteger(body.hours) || body.hours < 1 || body.hours > 87600 || Object.hasOwn(body, 'ends_at')) {
            throw new HttpError(400, 'Hourly rentals require hours from 1 to 87600 and no ends_at');
        }
        const endsAt = new Date(startsAt.getTime() + body.hours * 3600000);
        if (endsAt.getUTCFullYear() > 9999) throw new HttpError(400, 'Rental end is outside the supported range');
        return { rentalType: type, periodMonths: null, endsAt };
    }
    if (Object.hasOwn(body, 'hours')) throw new HttpError(400, 'hours is only valid for hourly rentals');
    if (type === 'custom') {
        const endsAt = timestamp(body.ends_at, 'ends_at');
        if (endsAt <= startsAt) throw new HttpError(400, 'ends_at must be after starts_at');
        return { rentalType: type, periodMonths: null, endsAt };
    }
    if (Object.hasOwn(body, 'ends_at')) throw new HttpError(400, 'Calendar rentals calculate ends_at; use custom for an explicit end');
    return { rentalType: type, periodMonths: type === 'monthly' ? 1 : 3, endsAt: null };
}
function creation(body) {
    input.object(body, ['customer_id', 'slot_id', 'starts_at', 'rental_type', 'hours', 'ends_at', 'timezone', 'agreed_price', 'currency']);
    const startsAt = timestamp(body.starts_at, 'starts_at');
    return { customerId: input.id(body.customer_id, 'customer ID'), slotId: input.id(body.slot_id, 'slot ID'), startsAt,
        ...period(body, startsAt), ...price(body), timezone: body.timezone === undefined ? null : timezone(body.timezone) };
}
module.exports = { timestamp, timezone, price, period, creation };
