import { Response } from "express";

const getCookieOptions = () => {
  const isProduction = process.env.NODE_ENV === "production";

  return {
    httpOnly: true,
    sameSite: isProduction ? "none" as const : "lax" as const,
    secure: isProduction,
    maxAge: 24 * 60 * 60 * 1000, // 24 hrs
    path: "/",
  };
};

export const setSessionCookie = (res: Response, token: string) => {
  res.cookie("geo_session", token, getCookieOptions());
};

export const clearSessionCookie = (res: Response) => {
  res.clearCookie("geo_session", getCookieOptions());
};

export const setAuthCookie = (res: Response, token: string) => {
  res.cookie("token", token, getCookieOptions());
};

export const clearAuthCookie = (res: Response) => {
  res.clearCookie("token", getCookieOptions());
};
