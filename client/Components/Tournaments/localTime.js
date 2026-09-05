/**
 * ARCHON: the two conversions an organizer's start time needs.
 *
 * `<input type="datetime-local">` speaks the browser's wall clock with no zone
 * on it. The server parses whatever it is given with `new Date(...)`, in ITS
 * zone - UTC in production - so sending the raw input booked a Chicago
 * organizer's 7pm event for 7pm UTC, and reading the stored instant back with
 * `toISOString().slice(0, 16)` showed midnight in the settings form. Instants
 * cross the wire; wall clocks stay in the browser.
 */

const pad = (value) => String(value).padStart(2, '0');

/**
 * An instant (ISO string or Date) as the local wall-clock string the input
 * wants, or '' when there is none.
 */
export const toLocalInputValue = (value) => {
    if (!value) {
        return '';
    }

    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
        return '';
    }

    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `T${pad(date.getHours())}:${pad(date.getMinutes())}`
    );
};

/**
 * A local wall-clock input value as the UTC instant the server should store,
 * or undefined when the field is empty or unreadable.
 */
export const toServerTime = (inputValue) => {
    if (!inputValue) {
        return undefined;
    }

    const date = new Date(inputValue);

    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};
