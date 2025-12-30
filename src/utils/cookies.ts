import { Response } from "express";

// const isProd = process.env.NODE_ENV === "production";
export const setSessionCookie = (res: Response, token: string) => {
  res.cookie("geo_session", token, {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    // secure: isProd, // ❗ false on localhost
    // sameSite: isProd ? "strict" : "lax",
    maxAge: 24 * 60 * 60 * 1000, // 24 hrs
    path: "/",
  });
};

export const clearSessionCookie = (res: Response) => {
  res.clearCookie("geo_session", {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    // secure: isProd,
    // sameSite: isProd ? "strict" : "lax",
  });
};
