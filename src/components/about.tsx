import ABOUT from "#const/about.json" assert { type: "json" };

const formatBuildTime = (iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const pad = (value: number): string => value.toString().padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export const AboutDialog: React.FC<{
    dialogRef: React.RefObject<HTMLDialogElement>;
    lang: Language;
}> = ({ dialogRef, lang }) => {
    const appInfo = import.meta.env.app!;
    const updatedLabel = formatBuildTime(appInfo.updateTime);

    return (
        <dialog
            className="about-dialog"
            ref={dialogRef}
            aria-labelledby="about-title"
            onClick={(ev) => ev.target === ev.currentTarget && ev.currentTarget.close()}
        >
            <article>
                <h2 id="about-title">{lang.about.title}</h2>
                <p className="about-version">
                    v{appInfo.version} · {appInfo.hash}
                </p>
                <dl>
                    <div>
                        <dt>{lang.about.updatedAt}</dt>
                        <dd>
                            <time dateTime={appInfo.updateTime}>{updatedLabel}</time>
                        </dd>
                    </div>
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
};
