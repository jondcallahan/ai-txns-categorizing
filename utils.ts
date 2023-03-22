export const trytm = async <T>(
  promise: Promise<T>,
): Promise<[T, null] | [null, Error]> => {
  try {
    const data = await promise;
    return [data, null];
  } catch (throwable) {
    if (throwable instanceof Error) return [null, throwable];

    throw throwable;
  }
};

export function cleanText(text: string) {
  // Strip all newlines
  return text.replace(/\n/g, " ")
    // Combine all multiple spaces into one
    .replace(/ +/g, " ");
}
