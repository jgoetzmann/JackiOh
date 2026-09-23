// An email address as prose shows it: allowed to wrap before its "@", so a long address in a narrow
// column (a phone held sideways sets the sign-in and reset titles beside the form) breaks between
// its two halves rather than at whatever letter reached the edge. A half too long for the line on
// its own still breaks inside (`overflow-wrap: anywhere` on the `strong` around it, auth/tavern.css).
//
// Only a <wbr>: no character is added, so the text an element reads (and a test asserts) is the
// address exactly.

import type { ReactElement } from "react";

export default function Address({ value }: { value: string }): ReactElement {
  const at = value.lastIndexOf("@");
  if (at <= 0) return <>{value}</>;
  return (
    <>
      {value.slice(0, at)}
      <wbr />
      {value.slice(at)}
    </>
  );
}
