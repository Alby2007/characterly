/** JSON-LD is data: stringify then neutralise `</` so a crafted string (a
 *  listing name, say) can't close the script block. */
export const jsonLd = (data: unknown) => JSON.stringify(data).replace(/<\//g, "<\\/");
