function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDateOfBirth(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,4})\D+(\d{1,2})\D+(\d{1,4})$/);
  if (!match) return null;
  const first = Number.parseInt(match[1], 10);
  const second = Number.parseInt(match[2], 10);
  const third = Number.parseInt(match[3], 10);
  const year = match[1].length === 4 ? first : third;
  const month = match[1].length === 4 ? second : first;
  const day = match[1].length === 4 ? third : second;
  const currentYear = new Date().getFullYear();
  if (
    !Number.isFinite(year)
    || !Number.isFinite(month)
    || !Number.isFinite(day)
    || year < 1900
    || year > currentYear - 13
    || month < 1
    || month > 12
    || day < 1
    || day > 31
  ) {
    return null;
  }
  return { year, month, day };
}

export function buildSignupProfilePayload(context = {}) {
  const guest = context.checkoutProfile?.guest || context.pluginGuestProfile || {};
  const configuredDate = context.config?.runner?.signupDateOfBirth
    || context.config?.runner?.signupBirthday
    || "";
  const dateOfBirth = configuredDate || guest.dateOfBirth || guest.birthday || "04/15/1986";
  const parsedDate = parseDateOfBirth(dateOfBirth) || parseDateOfBirth("04/15/1986");
  const fallbackAge = positiveInt(context.config?.runner?.signupAge, 25);
  const computedAge = parsedDate
    ? Math.max(13, new Date().getFullYear() - Number(parsedDate.year))
    : fallbackAge;
  return {
    firstName: guest.firstName || "",
    lastName: guest.lastName || "",
    age: fallbackAge,
    computedAge,
    dateOfBirth,
    ...(parsedDate || {}),
  };
}

