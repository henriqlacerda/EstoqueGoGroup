const highlights = [
  { label: "Produtos cadastrados", value: "—", icon: "▦" },
  { label: "Estoque baixo", value: "—", icon: "⌁" },
  { label: "Movimentações hoje", value: "—", icon: "↗" },
];

export default function Home() {
  return (
    <main className="page-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="EstoqueGoGroup, início">
          <span className="brand-mark">E</span>
          <span>Estoque<span className="brand-light">Go</span></span>
        </a>

        <p className="nav-caption">MENU PRINCIPAL</p>
        <nav aria-label="Menu principal">
          <a className="nav-link nav-link-active" href="/">
            <span aria-hidden="true">▦</span> Visão geral
          </a>
          <a className="nav-link nav-link-muted" href="#produtos">
            <span aria-hidden="true">□</span> Produtos
          </a>
          <a className="nav-link nav-link-muted" href="#movimentacoes">
            <span aria-hidden="true">↕</span> Movimentações
          </a>
        </nav>

        <div className="sidebar-bottom">
          <span className="status-dot" />
          <span>Sistema pronto para configurar</span>
        </div>
      </aside>

      <section className="main-area">
        <header className="topbar">
          <span className="breadcrumb">Estoque <span>/</span> Visão geral</span>
          <span className="workspace-pill"><span className="workspace-dot" /> Espaço de trabalho</span>
        </header>

        <div className="content">
          <div className="welcome-row">
            <div>
              <p className="eyebrow">PAINEL DE CONTROLE</p>
              <h1>Visão geral</h1>
              <p className="subtitle">Acompanhe o que acontece com o seu estoque.</p>
            </div>
            <a className="primary-button" href="#produtos"><span aria-hidden="true">＋</span> Adicionar produto</a>
          </div>

          <div className="metrics-grid" aria-label="Resumo do estoque">
            {highlights.map((item) => (
              <article className="metric-card" key={item.label}>
                <div className="metric-heading"><span>{item.label}</span><span className="metric-icon" aria-hidden="true">{item.icon}</span></div>
                <strong>{item.value}</strong>
                <p>Os dados aparecerão aqui quando você cadastrar seus itens.</p>
              </article>
            ))}
          </div>

          <section className="empty-card" id="produtos">
            <div className="empty-illustration" aria-hidden="true">
              <span className="box box-back" />
              <span className="box box-front" />
              <span className="sparkle">✳</span>
            </div>
            <p className="eyebrow">SEU ESTOQUE COMEÇA AQUI</p>
            <h2>Organize seus produtos em um só lugar</h2>
            <p className="empty-copy">Cadastre seus itens para acompanhar quantidades e movimentações com mais clareza.</p>
            <a className="secondary-button" href="#produtos"><span aria-hidden="true">＋</span> Cadastrar primeiro produto</a>
          </section>

          <footer className="footer" id="movimentacoes">EstoqueGoGroup <span>·</span> Gestão simples para o dia a dia</footer>
        </div>
      </section>
    </main>
  );
}
