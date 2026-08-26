const markdownIt = require("markdown-it");
const yaml = require("js-yaml");
const md = markdownIt({ html: true });

module.exports = function (eleventyConfig) {
  // Enable YAML as a global/front-matter data file format
  eleventyConfig.addDataExtension("yaml", (contents) => yaml.load(contents));

  // Pass through static assets untouched
  eleventyConfig.addPassthroughCopy("src/images");
  eleventyConfig.addPassthroughCopy("src/fonts");
  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addPassthroughCopy("src/base.css");
  eleventyConfig.addPassthroughCopy("src/style.css");
  eleventyConfig.addPassthroughCopy("src/robots.txt");
  eleventyConfig.addPassthroughCopy("src/og-image.png");
  eleventyConfig.addPassthroughCopy("sitemap.xml");
  eleventyConfig.addPassthroughCopy("_headers");
  eleventyConfig.addPassthroughCopy({ "webapp": "webapp" });
  eleventyConfig.addPassthroughCopy({ "admin": "admin" });

  // Inline markdown filter for short bold/italic snippets in content fields
  eleventyConfig.addFilter("mdInline", (str) => {
    if (!str) return "";
    return md.renderInline(str);
  });

  return {
    dir: {
      input: "src",
      includes: "_includes",
      data: "../content",
      output: "_site",
    },
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
  };
};
