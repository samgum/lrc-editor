import ABOUT from "#const/about.json" assert { type: "json" };

export const AboutDialog: React.FC<{
    dialogRef: React.RefObject<HTMLDialogElement>;
    lang: Language;
}> = ({ dialogRef, lang }) => (
    <dialog
        className="about-dialog"
        ref={dialogRef}
        aria-labelledby="about-title"
        onClick={(ev) => ev.target === ev.currentTarget && ev.currentTarget.close()}
    >
        <article>
            <h2 id="about-title">{lang.about.title}</h2>
            <p className="about-version">v{import.meta.env.app!.version}</p>
            <dl>
                <div>
                    <dt>{lang.about.developedBy}</dt>
                    <dd>
                        <a href={ABOUT.developer.url} target="_blank" rel="noopener noreferrer">
                            {ABOUT.developer.name}
                        </a>
                    </dd>
                </div>
                {ABOUT.repository !== ABOUT.developer.url && (
                    <div>
                        <dt>{lang.about.repository}</dt>
                        <dd>
                            <a href={ABOUT.repository} target="_blank" rel="noopener noreferrer">
                                samgum/lrc-editor
                            </a>
                        </dd>
                    </div>
                )}
            </dl>

            <h3>{lang.about.references}</h3>
            <ul>
                {ABOUT.references.map((reference) => (
                    <li key={reference.url}>
                        <a href={reference.url} target="_blank" rel="noopener noreferrer">
                            {reference.name}
                        </a>
                        <span>{reference.author}</span>
                    </li>
                ))}
            </ul>
            <p>{lang.about.license}</p>

            <form method="dialog">
                <button className="button" type="submit">
                    {lang.about.close}
                </button>
            </form>
        </article>
    </dialog>
);
