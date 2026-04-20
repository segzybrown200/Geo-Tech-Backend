import { Response } from "express";

const getCookieOptions = () => {
  // Check for production environment
  // In production deployments (Vercel, etc.), VERCEL env var is set
  // For local development, even with NODE_ENV=production, allow insecure cookies
  const isProduction = process.env.VERCEL === "1" ||
                      (process.env.NODE_ENV === "production" && !process.env.VERCEL);

  return {
    httpOnly: true,
    sameSite: isProduction ? "none" as const : "lax" as const,
    secure: isProduction,
    maxAge: 24 * 60 * 60 * 1000, // 24 hrs
    path: "/",
  };
};

const getClearCookieOptions = () => {
  // Check for production environment
  const isProduction = process.env.VERCEL === "1" ||
                      (process.env.NODE_ENV === "production" && !process.env.VERCEL);

  return {
    httpOnly: true,
    sameSite: isProduction ? "none" as const : "lax" as const,
    secure: isProduction,
    path: "/",
  };
};

export const setSessionCookie = (res: Response, token: string) => {
  res.cookie("geo_session", token, getCookieOptions());
};

export const clearSessionCookie = (res: Response) => {
  res.clearCookie("geo_session", getClearCookieOptions());
};

export const setAuthCookie = (res: Response, token: string) => {
  res.cookie("token", token, getCookieOptions());
};

export const clearAuthCookie = (res: Response) => {
  res.clearCookie("token", getClearCookieOptions());
};
