import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Link } from "react-router-dom";
import Header from "../../components/Header";
import SiteFooter from "../../components/SiteFooter";
import { CONTACT_FORM_ENDPOINT } from "../../helpers/copy";
import styles from "./ContactPage.module.css";

// The site's own contact page. Inquiries go to BodyMaps, Inc. through the same
// Formspree form that thebodymaps.com/contact posts to, with the same fields,
// so they land in the same inbox and are routed the same way; only the page
// around the form is this site's.

type Fields = {
  name: string;
  email: string;
  org: string;
  role: string;
  type: string;
  message: string;
  source: string;
  /** Formspree's spam trap: hidden from people, filled in by bots. */
  _gotcha: string;
};

type FieldName = Exclude<keyof Fields, "_gotcha">;
type Errors = Partial<Record<FieldName, string>>;

const EMPTY: Fields = {
  name: "",
  email: "",
  org: "",
  role: "",
  type: "",
  message: "",
  source: "",
  _gotcha: "",
};

const INQUIRY_TYPES = [
  { value: "hospital", label: "Hospital or clinician" },
  { value: "research", label: "Research" },
  { value: "pharma", label: "Pharma" },
  { value: "investor", label: "Investor" },
  { value: "partnership", label: "Partnership" },
  { value: "other", label: "Other" },
];

/** Checked in this order, so focus goes to the first problem on the page. */
const REQUIRED_ORDER: FieldName[] = ["name", "email", "org", "role", "type", "message"];

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateInquiry(fields: Fields): Errors {
  const errors: Errors = {};
  if (!fields.name.trim()) errors.name = "Enter your name.";
  if (!fields.email.trim()) errors.email = "Enter your work email.";
  else if (!EMAIL_SHAPE.test(fields.email.trim())) errors.email = "Enter an email address like name@hospital.org.";
  if (!fields.org.trim()) errors.org = "Enter your organization.";
  if (!fields.role.trim()) errors.role = "Enter your role or title.";
  if (!fields.type) errors.type = "Choose the kind of inquiry.";
  const message = fields.message.trim();
  if (!message) errors.message = "Tell us a little about your inquiry.";
  else if (message.length < 20) errors.message = "Add a sentence or two so we can route it.";
  return errors;
}

/** Joined in code, as thebodymaps.com does, so the address never appears
 *  whole in the bundle for scrapers that grep for it. */
const CONTACT_EMAIL = ["hello", "thebodymaps.com"].join("@");

function EmailLink() {
  return (
    <a className={styles.inlineLink} href={`mailto:${CONTACT_EMAIL}`}>
      {CONTACT_EMAIL}
    </a>
  );
}

type TextFieldProps = {
  id: FieldName;
  label: string;
  value: string;
  error?: string;
  required?: boolean;
  type?: string;
  autoComplete?: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
};

function TextField({ id, label, value, error, required, type = "text", autoComplete, onChange }: TextFieldProps) {
  const fieldId = `contact-${id}`;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={fieldId}>
        {label}
        {required ? <span className={styles.req} aria-hidden="true"> *</span> : <span className={styles.optional}> (optional)</span>}
      </label>
      <input
        id={fieldId}
        name={id}
        className={styles.input}
        type={type}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : undefined}
      />
      {error && (
        <p className={styles.error} id={`${fieldId}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

export default function ContactPage() {
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const thanksRef = useRef<HTMLHeadingElement>(null);
  const sendErrorRef = useRef<HTMLDivElement>(null);

  // The confirmation replaces the form, so focus moves to its heading;
  // otherwise it would fall back to the page and a screen reader would hear
  // nothing about the send.
  useEffect(() => {
    if (sentTo) thanksRef.current?.focus();
  }, [sentTo]);

  const update =
    (key: keyof Fields) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      const value = e.target.value;
      setFields((f) => ({ ...f, [key]: value }));
      if (key !== "_gotcha" && errors[key]) setErrors((errs) => ({ ...errs, [key]: undefined }));
    };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (sending) return;
    const found = validateInquiry(fields);
    setErrors(found);
    const first = REQUIRED_ORDER.find((k) => found[k]);
    if (first) {
      formRef.current?.querySelector<HTMLElement>(`#contact-${first}`)?.focus();
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch(CONTACT_FORM_ENDPOINT, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, _subject: `BodyMaps website inquiry: ${fields.type || "general"}` }),
      });
      if (res.ok) {
        setSentTo(fields.email.trim());
        setFields(EMPTY);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { errors?: { message?: string }[]; error?: string };
      setSendError(body.errors?.[0]?.message || body.error || "The form service did not accept the message.");
    } catch {
      setSendError("The message could not reach the form service. Check your connection.");
    } finally {
      setSending(false);
    }
  };

  // Announced by the alert role; focus moves there too, so a keyboard user
  // who pressed Send is not left on a button that did nothing visible.
  useEffect(() => {
    if (sendError) sendErrorRef.current?.focus();
  }, [sendError]);

  return (
    <div className={styles.page}>
      <Header />
      <main className={styles.main}>
        <div className={styles.grid}>
          {/* Separate blocks rather than one column, so a phone can put the
              form right after the heading and the PHI rule (see the CSS). */}
          <div className={styles.head}>
            <p className={styles.eyebrow}>Contact</p>
            <h1 className={styles.title}>
              Get in <span className={styles.titleBold}>touch.</span>
            </h1>
            <p className={styles.lead}>
              For partnerships, research collaborations, pilots, licensing and press. BodyMaps, Inc. reads every
              inquiry and usually replies within one business day.
            </p>
          </div>

          <div className={styles.include}>
            <h2 className={styles.subhead}>What helps us route it</h2>
            <ul className={styles.list}>
              <li>Your organization, your team and the problem you are working on.</li>
              <li>The imaging modalities, the scale and any deadlines.</li>
              <li>Whether you are evaluating, piloting or ready to contract.</li>
            </ul>
          </div>

          <p className={styles.notice}>
            <strong>Do not send protected health information,</strong> patient records or identifiable medical
            images through this form.
          </p>

          <p className={styles.altEmail}>
            Prefer email? Write to <EmailLink />.
          </p>

          <div className={styles.card}>
            {sentTo ? (
              <div className={styles.thanks}>
                <h2 ref={thanksRef} tabIndex={-1} className={styles.thanksTitle}>
                  Thanks, your inquiry is on its way.
                </h2>
                <p className={styles.thanksBody}>
                  Someone from BodyMaps, Inc. will reply to <strong>{sentTo}</strong>, usually within one business
                  day.
                </p>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => {
                    setSentTo(null);
                    setSendError(null);
                  }}
                >
                  Send another inquiry
                </button>
              </div>
            ) : (
              <form ref={formRef} className={styles.form} onSubmit={onSubmit} noValidate aria-label="Contact form">
                <p className={styles.formNote}>
                  Fields marked <span aria-hidden="true">*</span>
                  <span className={styles.srOnly}>with an asterisk</span> are required.
                </p>
                <div className={styles.row}>
                  <TextField
                    id="name"
                    label="Name"
                    required
                    value={fields.name}
                    error={errors.name}
                    autoComplete="name"
                    onChange={update("name")}
                  />
                  <TextField
                    id="email"
                    label="Work email"
                    type="email"
                    required
                    value={fields.email}
                    error={errors.email}
                    autoComplete="email"
                    onChange={update("email")}
                  />
                </div>
                <div className={styles.row}>
                  <TextField
                    id="org"
                    label="Organization"
                    required
                    value={fields.org}
                    error={errors.org}
                    autoComplete="organization"
                    onChange={update("org")}
                  />
                  <TextField
                    id="role"
                    label="Role or title"
                    required
                    value={fields.role}
                    error={errors.role}
                    autoComplete="organization-title"
                    onChange={update("role")}
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="contact-type">
                    Inquiry type<span className={styles.req} aria-hidden="true"> *</span>
                  </label>
                  <select
                    id="contact-type"
                    name="type"
                    className={`${styles.input} ${styles.select}`}
                    value={fields.type}
                    onChange={update("type")}
                    required
                    aria-invalid={errors.type ? true : undefined}
                    aria-describedby={errors.type ? "contact-type-error" : undefined}
                  >
                    <option value="">Choose one</option>
                    {INQUIRY_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  {errors.type && (
                    <p className={styles.error} id="contact-type-error">
                      {errors.type}
                    </p>
                  )}
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="contact-message">
                    Message<span className={styles.req} aria-hidden="true"> *</span>
                  </label>
                  <textarea
                    id="contact-message"
                    name="message"
                    className={`${styles.input} ${styles.textarea}`}
                    rows={6}
                    value={fields.message}
                    onChange={update("message")}
                    placeholder="What would you like to discuss?"
                    required
                    aria-invalid={errors.message ? true : undefined}
                    aria-describedby={errors.message ? "contact-message-error" : undefined}
                  />
                  {errors.message && (
                    <p className={styles.error} id="contact-message-error">
                      {errors.message}
                    </p>
                  )}
                </div>

                <TextField
                  id="source"
                  label="How did you hear about us?"
                  value={fields.source}
                  onChange={update("source")}
                />

                {/* Off screen and out of the tab order; people never see it. */}
                <div className={styles.trap} aria-hidden="true">
                  <label htmlFor="contact-gotcha">Leave this field empty</label>
                  <input
                    id="contact-gotcha"
                    type="text"
                    tabIndex={-1}
                    autoComplete="off"
                    value={fields._gotcha}
                    onChange={update("_gotcha")}
                  />
                </div>

                {sendError && (
                  <div ref={sendErrorRef} tabIndex={-1} className={styles.sendError} role="alert">
                    <strong>Your message was not sent.</strong> {sendError} Try again, or email{" "}
                    <EmailLink />.
                  </div>
                )}

                <div className={styles.submitRow}>
                  <button type="submit" className={styles.primary} disabled={sending} aria-busy={sending || undefined}>
                    {sending ? "Sending…" : "Send inquiry"}
                  </button>
                  <p className={styles.fineprint}>
                    Your message goes to BodyMaps, Inc. through Formspree. See the{" "}
                    <Link className={styles.inlineLink} to="/privacy">
                      Privacy Notice
                    </Link>
                    .
                  </p>
                </div>
              </form>
            )}
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
