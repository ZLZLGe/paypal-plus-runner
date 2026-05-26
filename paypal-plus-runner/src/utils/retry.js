export async function retry(fn, { attempts = 3, delayMs = 1000 } = {}) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await fn(index);
    } catch (error) {
      lastError = error;
      if (index < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}
