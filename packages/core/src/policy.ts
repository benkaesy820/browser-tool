/** URL policy for Phase 0. Redirect/request validation lands in Phase 5. */
export function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    const err = new Error(`Invalid URL: ${raw}`);
    (err as NodeJS.ErrnoException).code = "INVALID_REQUEST";
    throw err;
  }
  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:" &&
    url.protocol !== "file:"
  ) {
    const err = new Error(
      `Blocked protocol ${url.protocol}. Allowed: http, https, file.`,
    );
    (err as NodeJS.ErrnoException).code = "POLICY_DENIED";
    throw err;
  }
  if (url.username !== "" || url.password !== "") {
    const err = new Error("Credentials in URL are not allowed.");
    (err as NodeJS.ErrnoException).code = "POLICY_DENIED";
    throw err;
  }
  return url;
}
