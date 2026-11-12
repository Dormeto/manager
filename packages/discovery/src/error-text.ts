// An error as one line of text: its name and its message ("ThrottlingException: Rate exceeded").
export const errorText = (err: unknown): string => `${(err as Error)?.name ?? 'Error'}: ${(err as Error)?.message ?? String(err)}`;
