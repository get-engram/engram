import { describe, it, expect } from "vitest";
import { isAcademicEmail, emailDomain } from "../academic-domains.js";

describe("emailDomain", () => {
  it("extracts and lowercases", () => {
    expect(emailDomain("Ali.Shah@LeoMail.TAMUC.edu")).toBe("leomail.tamuc.edu");
  });
  it("rejects malformed addresses", () => {
    for (const bad of ["", "nope", "@x.edu", "a@", "a@b", "a b@c.edu"]) {
      expect(emailDomain(bad), bad).toBeNull();
    }
  });
  it("uses the LAST @ so quoted locals don't fool it", () => {
    expect(emailDomain("weird@name@ox.ac.uk")).toBe("ox.ac.uk");
  });
});

describe("isAcademicEmail", () => {
  it("accepts the address that prompted this feature", () => {
    // A flat allowlist would likely have missed this subdomain.
    expect(isAcademicEmail("ashah24@leomail.tamuc.edu")).toBe(true);
  });

  it("accepts .edu at any subdomain depth", () => {
    for (const e of [
      "a@mit.edu",
      "a@cs.stanford.edu",
      "a@mail.student.berkeley.edu",
    ]) {
      expect(isAcademicEmail(e), e).toBe(true);
    }
  });

  it("accepts ac.<cc> and edu.<cc> internationally", () => {
    for (const e of [
      "a@ox.ac.uk",
      "a@cs.ox.ac.uk",
      "a@u-tokyo.ac.jp",
      "a@snu.ac.kr",
      "a@unimelb.edu.au",
      "a@tsinghua.edu.cn",
      "a@usp.edu.br",
      "a@nus.edu.sg",
      "a@boun.edu.tr",
    ]) {
      expect(isAcademicEmail(e), e).toBe(true);
    }
  });

  it("accepts listed institutions on ordinary national TLDs, and their subdomains", () => {
    expect(isAcademicEmail("a@ethz.ch")).toBe(true);
    expect(isAcademicEmail("a@mail.ethz.ch")).toBe(true);
    expect(isAcademicEmail("a@tum.de")).toBe(true);
  });

  it("rejects consumer mail", () => {
    for (const e of [
      "a@gmail.com",
      "a@outlook.com",
      "a@proton.me",
      "a@company.co.uk",
      "a@getengram.app",
    ]) {
      expect(isAcademicEmail(e), e).toBe(false);
    }
  });

  it("rejects K-12 and schools — this is higher-ed pricing", () => {
    expect(isAcademicEmail("a@someschool.sch.uk")).toBe(false);
    expect(isAcademicEmail("a@district.k12.ca")).toBe(false);
  });

  it("is not fooled by a lookalike domain that merely contains the pattern", () => {
    // The guard is suffix-based, so these must NOT pass.
    for (const e of [
      "a@edu.com",
      "a@notedu.org",
      "a@myedu.co",
      "a@ac.uk.evil.com",
      "a@mit.edu.attacker.net",
    ]) {
      expect(isAcademicEmail(e), e).toBe(false);
    }
  });
});
