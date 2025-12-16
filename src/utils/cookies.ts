import { Response } from "express";

export const setSessionCookie = (res: Response, token: string) => {
  res.cookie("geo_session", token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: 24 * 60 * 60 * 1000, // 24 hrs
  });
};

export const clearSessionCookie = (res: Response) => {
  res.clearCookie("geo_session", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
  });
};
