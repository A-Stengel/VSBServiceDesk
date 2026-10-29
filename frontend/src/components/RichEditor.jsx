import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extensions";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

// A rich text box with a small toolbar: bold, italic, underline, lists, links
// and clear formatting. Formatting pasted from Word or Outlook is kept. With
// "images", pictures can be pasted or dropped in; they're sent with the form
// (see extractInlineImages).
//
// "value" is HTML. Setting it to "" from outside (after sending) clears the
// box.
export default function RichEditor({ value, onChange, placeholder = "", images = false, label, minHeight = 120, onError }) {
  const [linking, setLinking] = useState(null);
  const editorRef = useRef(null);
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;

  function addImages(editor, files) {
    const pictures = [...files].filter((f) => f.type.startsWith("image/"));
    if (!pictures.length) return false;
    for (const file of pictures) {
      if (file.size > MAX_IMAGE_BYTES) {
        onError?.(`${file.name || "The picture"} is larger than 10 MB.`);
        continue;
      }
      readAsDataUrl(file).then((src) => editor.chain().focus().setImage({ src, alt: file.name || "" }).run());
    }
    return true;
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        code: false,
        codeBlock: false,
        horizontalRule: false,
        heading: { levels: [1, 2, 3, 4] },
        link: { openOnClick: false, autolink: true, defaultProtocol: "https", HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" } }
      }),
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
      ...(images ? [Image.configure({ inline: true, allowBase64: true })] : [])
    ],
    content: value || "",
    editorProps: {
      attributes: { class: "rich rich-input", role: "textbox", "aria-multiline": "true", ...(label ? { "aria-label": label } : {}) },
      // A picture on its own (a screenshot) is added as an image. Pasted
      // HTML (from Word, for example) is left to the editor.
      handlePaste: (view, event) => {
        const data = event.clipboardData;
        if (!images || !data?.files?.length || data.getData("text/html")) return false;
        return addImages(editorRef.current, data.files);
      },
      handleDrop: (view, event) => {
        if (!images || !event.dataTransfer?.files?.length) return false;
        event.preventDefault();
        return addImages(editorRef.current, event.dataTransfer.files);
      }
    },
    onUpdate: ({ editor: current }) => onChange(current.isEmpty ? "" : current.getHTML())
  });
  editorRef.current = editor;

  // Cleared or replaced from outside
  useEffect(() => {
    if (!editor) return;
    const current = editor.isEmpty ? "" : editor.getHTML();
    if ((value || "") !== current) editor.commands.setContent(value || "", { emitUpdate: false });
  }, [editor, value]);

  // A new placeholder (for example switching a reply to a note) shows straight away
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta("placeholder", placeholder));
  }, [editor, placeholder]);

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => e && {
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      link: e.isActive("link")
    }
  });
  if (!editor) return null;

  const button = (name, title, active, run, content) => (
    <button type="button" className={`tool ${active ? "on" : ""}`} title={title} aria-label={title} aria-pressed={!!active}
      onMouseDown={(e) => e.preventDefault()} onClick={run} key={name}>
      {content}
    </button>
  );

  function openLink() {
    setLinking(editor.getAttributes("link").href || "https://");
  }
  function saveLink(e) {
    e.preventDefault();
    const href = linking.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (!href || href === "https://") chain.unsetLink().run();
    else chain.setLink({ href: /^(https?:|mailto:)/i.test(href) ? href : `https://${href}` }).run();
    setLinking(null);
  }

  return (
    <div className="rich-editor" style={{ "--rich-min": `${minHeight}px` }}>
      <div className="toolbar" role="toolbar" aria-label="Formatting">
        {button("bold", "Bold", state?.bold, () => editor.chain().focus().toggleBold().run(), <strong>B</strong>)}
        {button("italic", "Italic", state?.italic, () => editor.chain().focus().toggleItalic().run(), <em>I</em>)}
        {button("underline", "Underline", state?.underline, () => editor.chain().focus().toggleUnderline().run(), <u>U</u>)}
        <span className="sep" />
        {button("bullet", "Bulleted list", state?.bullet, () => editor.chain().focus().toggleBulletList().run(), "• List")}
        {button("ordered", "Numbered list", state?.ordered, () => editor.chain().focus().toggleOrderedList().run(), "1. List")}
        <span className="sep" />
        {button("link", "Link", state?.link, openLink, "Link")}
        {button("clear", "Clear formatting", false, () => editor.chain().focus().unsetAllMarks().clearNodes().run(), "Clear")}
      </div>
      {linking !== null && (
        <div className="link-row">
          <input value={linking} onChange={(e) => setLinking(e.target.value)} aria-label="Link address" autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") saveLink(e); if (e.key === "Escape") setLinking(null); }} />
          <button type="button" className="btn sm" onClick={saveLink}>Save link</button>
          <button type="button" className="btn sm ghost" onClick={() => setLinking(null)}>Cancel</button>
        </div>
      )}
      <EditorContent editor={editor} />
      {images && <div className="muted small hint">You can paste or drag pictures into the text.</div>}
    </div>
  );
}
