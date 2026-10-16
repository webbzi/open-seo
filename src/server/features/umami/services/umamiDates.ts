import {
  ga4DateInTimeZone,
  inclusiveGa4Days,
  shiftGa4Date,
} from "@/server/features/ga4/services/Ga4Dates";

export type UmamiDateWindow = {
  startDate: string; // inclusive YYYY-MM-DD, local to timeZone
  endDate: string; // inclusive YYYY-MM-DD, local to timeZone
  startAt: number; // epoch ms of local midnight starting startDate
  endAt: number; // epoch ms of local midnight after endDate, minus 1
};

export type ResolvedUmamiDateRange = {
  timeZone: string;
  requested: { startDate: string | null; endDate: string | null };
  current: UmamiDateWindow;
  previous: UmamiDateWindow; // same number of calendar days, ending the day before current.startDate
  dayCount: number;
  warnings: "end_date_clamped"[];
};

const DEFAULT_DAY_COUNT = 28;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertCalendarDate(value: string, label: string): void {
  const match = DATE_PATTERN.exec(value);
  if (match) {
    const date = new Date(
      Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
    );
    if (date.toISOString().slice(0, 10) === value) return;
  }
  throw new RangeError(`${label} must be a valid YYYY-MM-DD date.`);
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const n = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  const localAsUtc = Date.UTC(
    n("year"),
    n("month") - 1,
    n("day"),
    n("hour"),
    n("minute"),
    n("second"),
  );
  return localAsUtc - Math.floor(instant / 1000) * 1000;
}

function localMidnightMs(date: string, timeZone: string): number {
  const wallClock = Date.parse(`${date}T00:00:00.000Z`);
  // Two passes so the offset is read at the resolved instant (DST edges).
  const first = wallClock - zoneOffsetMs(wallClock, timeZone);
  return wallClock - zoneOffsetMs(first, timeZone);
}

function buildWindow(
  startDate: string,
  endDate: string,
  timeZone: string,
): UmamiDateWindow {
  return {
    startDate,
    endDate,
    startAt: localMidnightMs(startDate, timeZone),
    endAt: localMidnightMs(shiftGa4Date(endDate, 1), timeZone) - 1,
  };
}

export function resolveUmamiDateRange(input: {
  startDate?: string;
  endDate?: string;
  timeZone: string;
  now?: Date;
}): ResolvedUmamiDateRange {
  const { timeZone } = input;
  if ((input.startDate === undefined) !== (input.endDate === undefined)) {
    throw new RangeError("Provide both startDate and endDate, or neither.");
  }

  const today = ga4DateInTimeZone(input.now ?? new Date(), timeZone);
  const yesterday = shiftGa4Date(today, -1);
  const warnings: "end_date_clamped"[] = [];
  let startDate: string;
  let endDate: string;

  if (input.startDate === undefined || input.endDate === undefined) {
    endDate = yesterday;
    startDate = shiftGa4Date(yesterday, -(DEFAULT_DAY_COUNT - 1));
  } else {
    assertCalendarDate(input.startDate, "startDate");
    assertCalendarDate(input.endDate, "endDate");
    if (input.startDate > input.endDate) {
      throw new RangeError("startDate must not be after endDate.");
    }
    startDate = input.startDate;
    endDate = input.endDate;
    if (endDate >= today) {
      endDate = yesterday;
      warnings.push("end_date_clamped");
      if (startDate > endDate) {
        throw new RangeError("The date range must end before today.");
      }
    }
  }

  const dayCount = inclusiveGa4Days(startDate, endDate);
  const previousEnd = shiftGa4Date(startDate, -1);
  const previousStart = shiftGa4Date(previousEnd, -(dayCount - 1));

  return {
    timeZone,
    requested: {
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
    },
    current: buildWindow(startDate, endDate, timeZone),
    previous: buildWindow(previousStart, previousEnd, timeZone),
    dayCount,
    warnings,
  };
}
