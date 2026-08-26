const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const MarkdownIt = require("markdown-it");
const md = new MarkdownIt({ html: true });

// Reads content/legal/*.md, parses front matter + markdown body,
// and exposes each as { title, seo_title, seo_description, effective_date, content (HTML) }
function loadLegalDoc(filename) {
  const raw = fs.readFileSync(path.join(__dirname, "legal", filename), "utf8");
  const { data, content } = matter(raw);
  return {
    ...data,
    content: md.render(content),
  };
}

module.exports = {
  privacy: loadLegalDoc("privacy.md"),
  terms: loadLegalDoc("terms.md"),
};
