import { Response } from "express";

const isProd = process.env.NODE_ENV === "production";

export const setSessionCookie = (res: Response, token: string) => {
  res.cookie("geo_session", token, {
    httpOnly: true,
    secure: isProd,               // ✅ true only in production (HTTPS)
    sameSite: isProd ? "none" : "lax", // ✅ cross-site only in prod
    maxAge: 24 * 60 * 60 * 1000, // 24 hrs
    path: "/",
  });
};

export const clearSessionCookie = (res: Response) => {
  res.clearCookie("geo_session", {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
  });
};
